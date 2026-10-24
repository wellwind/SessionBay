//! Pull/merge request data, cached per connection so hosts and accounts
//! never see each other's responses.
use std::{collections::HashMap, sync::Mutex};

#[derive(Default)]
pub struct Cache {
    entries: Mutex<HashMap<(String, String), (i64, serde_json::Value)>>,
}

impl Cache {
    pub fn get(&self, connection: &str, key: &str, max_age: i64) -> Option<serde_json::Value> {
        let entries = self.entries.lock().ok()?;
        let (at, value) = entries.get(&(connection.to_owned(), key.to_owned()))?;
        (super::now() - at <= max_age).then(|| value.clone())
    }
    pub fn put(&self, connection: &str, key: &str, value: serde_json::Value) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(
                (connection.to_owned(), key.to_owned()),
                (super::now(), value),
            );
        }
    }
    pub fn forget(&self, connection: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|(id, _), _| id != connection);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Cache;

    #[test]
    fn cache_entries_are_isolated_per_connection() {
        let cache = Cache::default();
        cache.put("github-a", "owner/repo#1", serde_json::json!("a"));
        assert_eq!(cache.get("github-b", "owner/repo#1", 60), None);
        assert_eq!(
            cache.get("github-a", "owner/repo#1", 60),
            Some(serde_json::json!("a"))
        );
        cache.forget("github-a");
        assert_eq!(cache.get("github-a", "owner/repo#1", 60), None);
    }
}
