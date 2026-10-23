//! Builds exact partial patches from a verified diff and a line selection.
//!
//! Staging applies a forward patch to the index: unselected deletions become
//! context and unselected additions disappear. Unstaging builds a patch whose
//! *new* side is the current index and applies it in reverse: unselected
//! additions become context and unselected deletions disappear.
use super::diff::{LineKind, RawDiff, RawLine};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Stage,
    Unstage,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct LineRef {
    pub hunk: usize,
    pub line: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum Selection {
    Hunks { hunks: Vec<usize> },
    Lines { lines: Vec<LineRef> },
}

/// Expands a selection into changed-line references and validates indices.
pub fn selected_lines(diff: &RawDiff, selection: &Selection) -> Result<HashSet<LineRef>, String> {
    let mut selected = HashSet::new();
    match selection {
        Selection::Hunks { hunks } => {
            for &hunk in hunks {
                let lines = &diff.hunks.get(hunk).ok_or("選取的區塊已不存在")?.lines;
                for (line, raw) in lines.iter().enumerate() {
                    if raw.kind != LineKind::Context {
                        selected.insert(LineRef { hunk, line });
                    }
                }
            }
        }
        Selection::Lines { lines } => {
            for reference in lines {
                let raw = diff
                    .hunks
                    .get(reference.hunk)
                    .and_then(|hunk| hunk.lines.get(reference.line))
                    .ok_or("選取的行已不存在")?;
                if raw.kind == LineKind::Context {
                    return Err("未變更的內容行不能暫存".into());
                }
                selected.insert(*reference);
            }
        }
    }
    if selected.is_empty() {
        return Err("沒有選取任何變更行".into());
    }
    Ok(selected)
}

/// Git's C-style quoting, accepted by `git apply` for any byte sequence.
pub fn quote_path(prefix: &[u8], path: &[u8]) -> Vec<u8> {
    let mut full = prefix.to_vec();
    full.extend_from_slice(path);
    let plain = full
        .iter()
        .all(|&b| b > b' ' && b < 0x7f && b != b'"' && b != b'\\');
    if plain {
        return full;
    }
    let mut out = vec![b'"'];
    for &byte in &full {
        match byte {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b' '..=0x7e => out.push(byte),
            _ => out.extend_from_slice(format!("\\{byte:03o}").as_bytes()),
        }
    }
    out.push(b'"');
    out
}

struct Built {
    old_count: u32,
    new_count: u32,
    lines: Vec<RawLine>,
}

fn check_eof_markers(lines: &[RawLine]) -> Result<(), String> {
    for (side, excluded) in [("原始", LineKind::Add), ("結果", LineKind::Delete)] {
        let side_lines: Vec<&RawLine> = lines.iter().filter(|l| l.kind != excluded).collect();
        if let Some(position) = side_lines.iter().position(|l| l.no_newline) {
            if position + 1 != side_lines.len() {
                return Err(format!(
                    "此選取會讓{side}內容的檔案結尾換行不一致；請一併選取相鄰的檔案末尾變更"
                ));
            }
        }
    }
    Ok(())
}

/// Returns `None` when the selection changes nothing.
pub fn build(
    diff: &RawDiff,
    path: &[u8],
    selected: &HashSet<LineRef>,
    direction: Direction,
) -> Result<Option<Vec<u8>>, String> {
    if diff.binary || diff.renamed || diff.submodule {
        return Err("此檔案不支援部分行操作".into());
    }
    let mut built = Vec::new();
    for (hunk_index, hunk) in diff.hunks.iter().enumerate() {
        let mut lines = Vec::with_capacity(hunk.lines.len());
        let mut changed = false;
        let mut index = 0;
        while index < hunk.lines.len() {
            if hunk.lines[index].kind == LineKind::Context {
                lines.push(hunk.lines[index].clone());
                index += 1;
                continue;
            }
            // One change block: git emits its deletions before its additions.
            let mut deletions = Vec::new();
            let mut additions = Vec::new();
            while index < hunk.lines.len() && hunk.lines[index].kind != LineKind::Context {
                let line = &hunk.lines[index];
                let chosen = selected.contains(&LineRef {
                    hunk: hunk_index,
                    line: index,
                });
                changed |= chosen;
                if line.kind == LineKind::Delete {
                    deletions.push((line, chosen));
                } else {
                    additions.push((line, chosen));
                }
                index += 1;
            }
            let as_kind = |line: &RawLine, kind| RawLine {
                kind,
                bytes: line.bytes.clone(),
                no_newline: line.no_newline,
            };
            match direction {
                // Old-side order is fixed; chosen additions follow the last
                // chosen deletion they replace, otherwise end the block.
                Direction::Stage => {
                    let anchor = deletions.iter().rposition(|(_, chosen)| *chosen);
                    let inserted: Vec<RawLine> = additions
                        .iter()
                        .filter(|(_, chosen)| *chosen)
                        .map(|(line, _)| as_kind(line, LineKind::Add))
                        .collect();
                    let mut inserted = Some(inserted);
                    if anchor.is_none() && deletions.is_empty() {
                        lines.extend(inserted.take().unwrap_or_default());
                    }
                    for (position, (line, chosen)) in deletions.iter().enumerate() {
                        lines.push(as_kind(
                            line,
                            if *chosen {
                                LineKind::Delete
                            } else {
                                LineKind::Context
                            },
                        ));
                        if Some(position) == anchor {
                            lines.extend(inserted.take().unwrap_or_default());
                        }
                    }
                    lines.extend(inserted.take().unwrap_or_default());
                }
                // New-side order is fixed; chosen deletions precede the first
                // chosen addition they pair with, otherwise start the block.
                Direction::Unstage => {
                    let anchor = additions.iter().position(|(_, chosen)| *chosen);
                    let mut removed: Option<Vec<RawLine>> = Some(
                        deletions
                            .iter()
                            .filter(|(_, chosen)| *chosen)
                            .map(|(line, _)| as_kind(line, LineKind::Delete))
                            .collect(),
                    );
                    if anchor.is_none() {
                        lines.extend(removed.take().unwrap_or_default());
                    }
                    for (position, (line, chosen)) in additions.iter().enumerate() {
                        if Some(position) == anchor {
                            lines.extend(removed.take().unwrap_or_default());
                        }
                        lines.push(as_kind(
                            line,
                            if *chosen {
                                LineKind::Add
                            } else {
                                LineKind::Context
                            },
                        ));
                    }
                    lines.extend(removed.take().unwrap_or_default());
                }
            }
        }
        if !changed {
            continue;
        }
        check_eof_markers(&lines)?;
        let old_count = lines.iter().filter(|l| l.kind != LineKind::Add).count() as u32;
        let new_count = lines.iter().filter(|l| l.kind != LineKind::Delete).count() as u32;
        built.push((
            hunk,
            Built {
                old_count,
                new_count,
                lines,
            },
        ));
    }
    if built.is_empty() {
        return Ok(None);
    }

    let all_changes_selected = diff
        .hunks
        .iter()
        .enumerate()
        .flat_map(|(h, hunk)| {
            hunk.lines
                .iter()
                .enumerate()
                .map(move |(l, line)| (h, l, line))
        })
        .filter(|(_, _, line)| line.kind != LineKind::Context)
        .all(|(hunk, line, _)| selected.contains(&LineRef { hunk, line }));
    let old_path = quote_path(b"a/", path);
    let new_path = quote_path(b"b/", path);
    // The file-level shape of the result on the side the patch writes.
    let mode = |value: &Option<String>| value.clone().unwrap_or_else(|| "100644".into());
    let (creates, deletes) = match direction {
        // Forward onto the index: a new file is always created, a deletion
        // only happens when every removed line is chosen.
        Direction::Stage => (diff.new_file, diff.deleted_file && all_changes_selected),
        // The patch's new side is the index. Reversing a "new file" removes it
        // only when every addition is chosen; a deleted file is restored by
        // reversing a deletion of just the chosen lines.
        Direction::Unstage => (diff.new_file && all_changes_selected, diff.deleted_file),
    };
    let mut patch = Vec::new();
    let line = |patch: &mut Vec<u8>, parts: &[&[u8]]| {
        for part in parts {
            patch.extend_from_slice(part);
        }
        patch.push(b'\n');
    };
    line(&mut patch, &[b"diff --git ", &old_path, b" ", &new_path]);
    if creates {
        line(
            &mut patch,
            &[format!("new file mode {}", mode(&diff.new_mode)).as_bytes()],
        );
        line(&mut patch, &[b"--- /dev/null"]);
        line(&mut patch, &[b"+++ ", &new_path]);
    } else if deletes {
        line(
            &mut patch,
            &[format!("deleted file mode {}", mode(&diff.old_mode)).as_bytes()],
        );
        line(&mut patch, &[b"--- ", &old_path]);
        line(&mut patch, &[b"+++ /dev/null"]);
    } else {
        line(&mut patch, &[b"--- ", &old_path]);
        line(&mut patch, &[b"+++ ", &new_path]);
    }

    // The side that matches real content keeps its original start; the
    // other side is recomputed from the counts of the hunks actually written.
    let mut offset: i64 = 0;
    for (original, hunk) in built {
        let (old_start, new_start) = match direction {
            Direction::Stage => {
                let first = first_line(original.old_start, original.old_count);
                (
                    original.old_start as i64,
                    start(first + offset, hunk.new_count),
                )
            }
            Direction::Unstage => {
                let first = first_line(original.new_start, original.new_count);
                (
                    start(first - offset, hunk.old_count),
                    original.new_start as i64,
                )
            }
        };
        offset += hunk.new_count as i64 - hunk.old_count as i64;
        patch.extend_from_slice(
            format!(
                "@@ -{},{} +{},{} @@\n",
                old_start, hunk.old_count, new_start, hunk.new_count
            )
            .as_bytes(),
        );
        for line in hunk.lines {
            patch.push(match line.kind {
                LineKind::Context => b' ',
                LineKind::Add => b'+',
                LineKind::Delete => b'-',
            });
            patch.extend_from_slice(&line.bytes);
            if !line.bytes.ends_with(b"\n") {
                patch.push(b'\n');
            }
            if line.no_newline {
                patch.extend_from_slice(b"\\ No newline at end of file\n");
            }
        }
    }
    Ok(Some(patch))
}

/// 1-based index of the first line a hunk side covers; a zero-count side's
/// start names the line before the insertion point.
fn first_line(start: u32, count: u32) -> i64 {
    if count == 0 {
        start as i64 + 1
    } else {
        start as i64
    }
}

fn start(first: i64, count: u32) -> i64 {
    if count == 0 {
        first - 1
    } else {
        first
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::parse;

    fn refs(items: &[(usize, usize)]) -> HashSet<LineRef> {
        items
            .iter()
            .map(|&(hunk, line)| LineRef { hunk, line })
            .collect()
    }

    #[test]
    fn stage_keeps_only_selected_changes_inside_one_hunk() {
        let diff = parse(
            b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+D\n",
        )
        .unwrap();
        // Select the second pair only.
        let patch = build(&diff, b"f", &refs(&[(0, 4), (0, 5)]), Direction::Stage)
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_utf8(patch).unwrap(),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n b\n c\n-d\n+D\n"
        );
    }

    #[test]
    fn unstage_reverse_patch_keeps_index_side_exact() {
        let diff =
            parse(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+new\n")
                .unwrap();
        let patch = build(&diff, b"f", &refs(&[(0, 3)]), Direction::Unstage)
            .unwrap()
            .unwrap();
        // New side must equal the index: a, B, new.
        assert_eq!(
            String::from_utf8(patch).unwrap(),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n B\n+new\n"
        );
    }

    #[test]
    fn later_hunks_shift_by_written_counts() {
        let diff = parse(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n a\n+x\n@@ -10,1 +11,2 @@\n j\n+y\n").unwrap();
        // Skip the first insertion: the second hunk's new start drops by one.
        let patch = build(&diff, b"f", &refs(&[(1, 1)]), Direction::Stage)
            .unwrap()
            .unwrap();
        assert!(String::from_utf8(patch)
            .unwrap()
            .contains("@@ -10,1 +10,2 @@\n j\n+y\n"));
    }

    #[test]
    fn end_of_file_newline_selection_must_be_consistent() {
        let diff = parse(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n x\n-y\n\\ No newline at end of file\n+z\n").unwrap();
        assert!(build(&diff, b"f", &refs(&[(0, 2)]), Direction::Stage).is_err());
        let patch = build(&diff, b"f", &refs(&[(0, 1)]), Direction::Stage)
            .unwrap()
            .unwrap();
        assert!(String::from_utf8(patch)
            .unwrap()
            .ends_with("-y\n\\ No newline at end of file\n"));
    }

    #[test]
    fn partial_new_and_deleted_files_get_correct_file_headers() {
        let new_file = parse(b"diff --git a/n b/n\nnew file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n").unwrap();
        let staged = String::from_utf8(
            build(&new_file, b"n", &refs(&[(0, 1)]), Direction::Stage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            staged.contains("new file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,1 @@\n+b\n")
        );
        let unstage_part = String::from_utf8(
            build(&new_file, b"n", &refs(&[(0, 0)]), Direction::Unstage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            unstage_part.contains("--- a/n\n+++ b/n\n@@ -1,1 +1,2 @@\n+a\n b\n"),
            "{unstage_part}"
        );
        let unstage_all = String::from_utf8(
            build(
                &new_file,
                b"n",
                &refs(&[(0, 0), (0, 1)]),
                Direction::Unstage,
            )
            .unwrap()
            .unwrap(),
        )
        .unwrap();
        assert!(unstage_all.contains("new file mode 100755"));

        let deleted = parse(b"diff --git a/d b/d\ndeleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n").unwrap();
        let partial = String::from_utf8(
            build(&deleted, b"d", &refs(&[(0, 0)]), Direction::Stage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            partial.contains("--- a/d\n+++ b/d\n@@ -1,2 +1,1 @@\n-a\n b\n"),
            "{partial}"
        );
        let restore = String::from_utf8(
            build(&deleted, b"d", &refs(&[(0, 1)]), Direction::Unstage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            restore.contains(
                "deleted file mode 100644\n--- a/d\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-b\n"
            ),
            "{restore}"
        );
    }

    #[test]
    fn replacements_stay_in_place_within_a_change_block() {
        let diff =
            parse(b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-x\n-y\n+X\n+Y\n")
                .unwrap();
        // Stage x -> X only: result X, y.
        let stage = String::from_utf8(
            build(&diff, b"f", &refs(&[(0, 0), (0, 2)]), Direction::Stage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(stage.ends_with("@@ -1,2 +1,2 @@\n-x\n+X\n y\n"), "{stage}");
        // Unstage y -> Y only from index X, Y: result X, y.
        let unstage = String::from_utf8(
            build(&diff, b"f", &refs(&[(0, 1), (0, 3)]), Direction::Unstage)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            unstage.ends_with("@@ -1,2 +1,2 @@\n X\n-y\n+Y\n"),
            "{unstage}"
        );
        assert_eq!(quote_path(b"b/", b"a b\"c"), b"\"b/a b\\\"c\"".to_vec());
    }
}
