//! Bounded, generation-local UI evidence. This is not an idle-exit authority.
use super::*;

pub(super) const CAPABILITY: &str = "uiOwnerLeaseV1";
pub(super) const OFFER_TTL: Duration = Duration::from_secs(30);
pub(super) const LEASE_TTL: Duration = Duration::from_secs(60);
pub(super) const RENEW_INTERVAL: Duration = Duration::from_secs(5);
const MAX_OFFERS: usize = 128;

struct Lease {
    id: String,
    deadline: Instant,
    sequence: u64,
    released: bool,
    expired: bool,
}
struct Offer {
    deadline: Instant,
    expired: bool,
    lease: Option<Lease>,
}
#[derive(Default)]
pub(super) struct Registry {
    offers: HashMap<String, Offer>,
    unknown_pin: bool,
    last_now: Option<Instant>,
}
impl Registry {
    pub(super) fn pin_unknown(&mut self) {
        self.unknown_pin = true;
    }
    pub(super) fn has_live(&mut self, now: Instant) -> bool {
        self.observe(now);
        self.offers.values().any(|offer| {
            offer
                .lease
                .as_ref()
                .is_some_and(|lease| !lease.released && !lease.expired && now < lease.deadline)
        })
    }
    pub(super) fn idle_clear(&mut self, now: Instant) -> bool {
        self.observe(now);
        !self.unknown_pin
            && self.offers.values().all(|offer| {
                offer
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.released && !lease.expired)
            })
    }
    fn observe(&mut self, now: Instant) {
        if self.last_now.is_some_and(|previous| now < previous) {
            self.unknown_pin = true;
        }
        self.last_now = Some(now);
        for offer in self.offers.values_mut() {
            // Expiration is a terminal state, not a predicate that clock rollback
            // can reverse. Consumed offers follow their lease's own deadline.
            match &mut offer.lease {
                Some(lease) => {
                    lease.expired |= !lease.released && now >= lease.deadline;
                    self.unknown_pin |= lease.expired;
                }
                None => {
                    offer.expired |= now >= offer.deadline;
                    self.unknown_pin |= offer.expired;
                }
            }
        }
    }
    pub(super) fn offer(&mut self, now: Instant) -> Option<String> {
        self.observe(now);
        // Tombstones prevent old acquire/release retries from reviving an owner.
        if self.offers.len() >= MAX_OFFERS {
            self.unknown_pin = true;
            return None;
        }
        let id = Uuid::new_v4().to_string();
        self.offers.insert(
            id.clone(),
            Offer {
                deadline: now + OFFER_TTL,
                expired: false,
                lease: None,
            },
        );
        Some(id)
    }
    pub(super) fn acquire(&mut self, offer: &str, now: Instant) -> Result<Response, String> {
        self.observe(now);
        let offer = self.offers.get_mut(offer).ok_or("Unknown UI lease offer")?;
        if offer.lease.is_none() {
            if offer.expired {
                return Err("UI lease offer expired".into());
            }
            offer.lease = Some(Lease {
                id: Uuid::new_v4().to_string(),
                deadline: now + LEASE_TTL,
                sequence: 0,
                released: false,
                expired: false,
            });
        }
        Self::reply(offer.lease.as_ref().unwrap(), now)
    }
    pub(super) fn renew(
        &mut self,
        id: &str,
        sequence: u64,
        now: Instant,
    ) -> Result<Response, String> {
        self.observe(now);
        let lease = self.find(id)?;
        if lease.released || lease.expired || now >= lease.deadline {
            return Err("UI lease is no longer valid".into());
        }
        if sequence != lease.sequence {
            if lease.sequence.checked_add(1) != Some(sequence) {
                return Err("Invalid UI lease sequence".into());
            }
            lease.sequence = sequence;
            lease.deadline = now + LEASE_TTL;
        }
        Self::reply(lease, now)
    }
    pub(super) fn release(&mut self, id: &str, now: Instant) -> Result<Response, String> {
        self.observe(now);
        self.find(id)?.released = true;
        Ok(Response::Ok)
    }
    fn find(&mut self, id: &str) -> Result<&mut Lease, String> {
        self.offers
            .values_mut()
            .filter_map(|offer| offer.lease.as_mut())
            .find(|lease| lease.id == id)
            .ok_or_else(|| "Unknown UI lease".into())
    }
    fn reply(lease: &Lease, now: Instant) -> Result<Response, String> {
        if lease.released || lease.expired || now >= lease.deadline {
            return Err("UI lease is no longer valid".into());
        }
        Ok(Response::UiLease {
            lease: lease.id.clone(),
            sequence: lease.sequence,
            valid_for_ms: lease.deadline.saturating_duration_since(now).as_millis() as u64,
        })
    }
}

impl Host {
    pub(super) fn ui_leases(&self) -> Result<MutexGuard<'_, Registry>, String> {
        // Unlike ordinary UI snapshots, lifecycle evidence cannot trust a poisoned lock.
        self.ui_leases
            .lock()
            .map_err(|_| "UI lease evidence is unavailable".into())
    }
}

#[cfg(test)]
impl Registry {
    pub(super) fn evidence(&mut self, now: Instant) -> (usize, usize, bool) {
        self.observe(now);
        let live =
            self.offers
                .values()
                .filter(|offer| {
                    offer.lease.as_ref().is_some_and(|lease| {
                        !lease.released && !lease.expired && now < lease.deadline
                    })
                })
                .count();
        let pending = self
            .offers
            .values()
            .filter(|offer| offer.lease.is_none() && !offer.expired)
            .count();
        (live, pending, self.unknown_pin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn acquired(registry: &mut Registry, offer: &str, now: Instant) -> String {
        let Response::UiLease { lease, .. } = registry.acquire(offer, now).unwrap() else {
            panic!()
        };
        lease
    }
    #[test]
    fn lost_acquire_and_renew_replies_are_idempotent_without_extending_deadlines() {
        let now = Instant::now();
        let mut registry = Registry::default();
        let offer = registry.offer(now).unwrap();
        let id = acquired(&mut registry, &offer, now);
        assert_eq!(
            acquired(&mut registry, &offer, now + Duration::from_secs(10)),
            id
        );
        let Response::UiLease { valid_for_ms, .. } = registry
            .renew(&id, 0, now + Duration::from_secs(10))
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(valid_for_ms, 50_000);
        registry
            .renew(&id, 1, now + Duration::from_secs(10))
            .unwrap();
        let Response::UiLease { valid_for_ms, .. } = registry
            .renew(&id, 1, now + Duration::from_secs(20))
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(valid_for_ms, 50_000);
        assert!(registry
            .renew(&id, 0, now + Duration::from_secs(20))
            .is_err());
        assert!(registry
            .renew(&id, 3, now + Duration::from_secs(20))
            .is_err());
    }
    #[test]
    fn released_and_expired_owners_cannot_be_revived_or_clear_unknown_evidence() {
        let now = Instant::now();
        let mut registry = Registry::default();
        let offer = registry.offer(now).unwrap();
        let id = acquired(&mut registry, &offer, now);
        registry.release(&id, now).unwrap();
        registry.release(&id, now).unwrap();
        assert!(registry.renew(&id, 1, now).is_err());
        assert!(registry.acquire(&offer, now).is_err());
        registry.observe(now + LEASE_TTL);
        assert!(!registry.unknown_pin);
        let offer = registry.offer(now + LEASE_TTL).unwrap();
        let id = acquired(&mut registry, &offer, now + LEASE_TTL);
        assert!(registry.renew(&id, 1, now + LEASE_TTL * 2).is_err());
        assert!(registry.unknown_pin);
        registry.release(&id, now + LEASE_TTL * 2).unwrap();
        let next = registry.offer(now + LEASE_TTL * 2).unwrap();
        acquired(&mut registry, &next, now + LEASE_TTL * 2);
        assert!(registry.unknown_pin);
    }
    #[test]
    fn dormant_legacy_hello_and_capacity_exhaustion_pin_the_generation() {
        let now = Instant::now();
        let mut registry = Registry::default();
        let legacy = registry.offer(now).unwrap();
        let modern = registry.offer(now).unwrap();
        acquired(&mut registry, &modern, now);
        assert!(registry.offers[&legacy].lease.is_none());
        assert!(registry.acquire(&legacy, now + OFFER_TTL).is_err());
        assert!(registry.unknown_pin);
        while registry.offers.len() < MAX_OFFERS {
            registry.offer(now + OFFER_TTL).unwrap();
        }
        assert!(registry.offer(now + OFFER_TTL).is_none());
        assert_eq!(registry.offers.len(), MAX_OFFERS);
    }
    #[test]
    fn expired_lease_stays_expired_after_clock_rollback_for_every_observation_path() {
        let now = Instant::now();
        for observation in 0..3 {
            let mut registry = Registry::default();
            let offer = registry.offer(now).unwrap();
            let id = acquired(&mut registry, &offer, now);
            let deadline = now + LEASE_TTL;
            match observation {
                0 => registry.observe(deadline),
                1 => assert!(registry.renew(&id, 1, deadline).is_err()),
                2 => assert!(registry.acquire(&offer, deadline).is_err()),
                _ => unreachable!(),
            }
            for at in [
                deadline - Duration::from_secs(1),
                now,
                deadline + Duration::from_secs(1),
            ] {
                assert!(
                    registry.renew(&id, 0, at).is_err(),
                    "expired duplicate renew revived: {observation}"
                );
                assert!(
                    registry.renew(&id, 1, at).is_err(),
                    "expired next renew revived: {observation}"
                );
                assert!(
                    registry.acquire(&offer, at).is_err(),
                    "expired acquire replay revived: {observation}"
                );
                assert_eq!(registry.evidence(at).0, 0);
                assert!(registry.unknown_pin);
                let lease = registry.find(&id).unwrap();
                assert_eq!(lease.sequence, 0);
                assert_eq!(lease.deadline, deadline);
            }
            registry.release(&id, now).unwrap();
            registry.release(&id, now).unwrap();
            assert!(registry.renew(&id, 1, now).is_err());
            assert!(registry.unknown_pin);
        }
    }
    #[test]
    fn expired_offer_stays_unredeemable_after_clock_rollback() {
        let now = Instant::now();
        for observation in 0..2 {
            let mut registry = Registry::default();
            let offer = registry.offer(now).unwrap();
            let deadline = now + OFFER_TTL;
            match observation {
                0 => registry.observe(deadline),
                1 => assert!(registry.acquire(&offer, deadline).is_err()),
                _ => unreachable!(),
            }
            for at in [
                deadline - Duration::from_secs(1),
                now,
                deadline + Duration::from_secs(1),
            ] {
                assert!(
                    registry.acquire(&offer, at).is_err(),
                    "expired offer redeemed: {observation}"
                );
                assert!(registry.offers[&offer].lease.is_none());
                assert!(registry.unknown_pin);
            }
        }
    }
    #[test]
    fn clock_regression_fails_closed() {
        let now = Instant::now();
        let mut registry = Registry::default();
        registry.offer(now);
        registry.observe(now - Duration::from_secs(1));
        assert!(registry.unknown_pin);
    }
}
