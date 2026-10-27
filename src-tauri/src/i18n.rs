//! User-facing message translation shared with the UI.
//!
//! Messages are written in English and double as lookup keys into the UI's
//! `zh-TW.json`. The UI reports its locale at startup; until then, and in tests,
//! messages stay in English.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

static CHINESE: AtomicBool = AtomicBool::new(false);
static ZH_TW: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/zh-TW.json")).unwrap_or_default()
});

/// Accepts the UI's BCP 47 locale; anything other than Chinese falls back to English.
pub fn set_locale(locale: &str) {
    CHINESE.store(
        locale.to_ascii_lowercase().starts_with("zh"),
        Ordering::Relaxed,
    );
}

/// Translates a message key. Unknown keys are returned unchanged.
pub fn tr(key: &str) -> String {
    lookup(key).unwrap_or(key).to_owned()
}

/// Translates a key and fills `{{name}}` placeholders.
pub fn tr_with(key: &str, values: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut text = tr(key);
    for (name, value) in values {
        text = text.replace(&format!("{{{{{name}}}}}"), &value.to_string());
    }
    text
}

fn lookup(key: &str) -> Option<&'static str> {
    CHINESE
        .load(Ordering::Relaxed)
        .then(|| ZH_TW.get(key).map(String::as_str))
        .flatten()
}

/// `tr!("Cannot read {{path}}", path = value)` translates and interpolates.
#[macro_export]
macro_rules! tr {
    ($key:literal) => { $crate::i18n::tr($key) };
    ($key:literal, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::tr_with($key, &[$((stringify!($name), &$value as &dyn ::std::fmt::Display)),+])
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_english_and_interpolates() {
        assert_eq!(
            tr_with("Created {{n}} files", &[("n", &3)]),
            "Created 3 files"
        );
        assert_eq!(tr("Unknown key"), "Unknown key");
    }

    #[test]
    fn catalog_parses() {
        assert!(ZH_TW.len() > 100);
    }
}
