# 永久刪除合成負面探針

狀態：只驗證部分危險交錯，不是永久刪除功能或 adapter 驗收。2026-10-17。全部只在新建 TemporaryDirectory 內產生 marker DB；沒有輸入路徑、Agent 啟動或真實對話。不要改成接受真實來源。

將各 Python 區塊單獨存為檔案，以 Python 執行即可；第三段需要 Python 提供 `Connection.setconfig` 與 `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`，不支援時不得移除保護後宣稱同一實驗。第二段使用系統 libsqlite3，版本可能不同於 Python 內建 SQLite。這些程式故意製造 SQLite 官方警告的活動資料庫搬移，僅限合成資料。

## 結果與解讀

Linux 實測：Python 3.12.14／SQLite 3.53.1；系統 libsqlite3 3.46.1。2026-10-17 從本文件三個程式區塊重新執行，皆 exit 0 並重現下列結果；exit 0 只代表探針跑完，不代表刪除安全。

- 基本探針：open 後、BEGIN 前換 root，UPDATE 改到 replacement；BEGIN 後或寫入後換 root 的這兩個測例改 original。後兩者不是一般 race-safe 證明。
- C API ABA：open(original)→換 root→BEGIN→換回→guard→DELETE。root、DB、WAL、SHM 的 dev/ino 全相同，HAS_MOVED 回 `[0,0]`，讀到 original，guard 通過；關閉／讀取後 original 和 replacement 的 marker 均消失。
- Python ABA（禁 close checkpoint）：同樣 path/content guard 通過，original 留下，replacement 被刪。Python wrapper 未提供 HAS_MOVED；不能宣稱 3.53.1 實測該 C API。
- C API NOFOLLOW 在此系統拒絕祖先 symlink；此結果不證明所有平台／VFS 行為一致。

這只否定「這組 path/content guards 能涵蓋外部 namespace ABA」；不否定穩定 namespace＋協作 writer 前提下的 stock-SQLite 方案。沒有測完 Windows/macOS、所有 SQLite build、WAL-only replacement、crash/power loss 或原地 restore。普通設定 generation 與受管 launch 競態應由穩定 coordinator lease 處理，不能與任意外部 namespace 置換混為一談。詳見[安全分析](permanent-deletion-safety-review.md)。

## 基本來源交換探針

```python
"""Negative safety probe. Only generated marker databases in a temporary directory.

This is not a deletion implementation. It demonstrates why a source checked
before sqlite3.connect() is not a sufficient authorization boundary for writes.
No user-provided path or Agent executable is accepted.
"""

import json
import pathlib
import sqlite3
import tempfile


def create_marker(path: pathlib.Path, value: str, wal: bool = False) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE marker(value TEXT)")
        connection.execute("INSERT INTO marker VALUES (?)", (value,))
    if wal:
        with sqlite3.connect(path) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
    connection.close()


def marker(path: pathlib.Path) -> str:
    connection = sqlite3.connect(path)
    try:
        return connection.execute("SELECT value FROM marker").fetchone()[0]
    finally:
        connection.close()


def probe(phase: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="sessionbay-synthetic-swap-") as temporary:
        parent = pathlib.Path(temporary)
        source = parent / "source"
        source.mkdir()
        replacement = parent / "replacement"
        replacement.mkdir()
        create_marker(source / "opencode.db", "original", wal=True)
        create_marker(replacement / "opencode.db", "replacement")
        connection = sqlite3.connect(source / "opencode.db")

        def replace_source() -> None:
            source.rename(parent / "original-source")
            replacement.rename(source)

        result = "ok"
        try:
            if phase == "before_begin":
                replace_source()
            connection.execute("BEGIN IMMEDIATE")
            if phase == "after_begin":
                replace_source()
            connection.execute("UPDATE marker SET value='changed-original'")
            if phase == "after_write":
                replace_source()
            connection.commit()
        except sqlite3.Error as error:
            result = f"{type(error).__name__}: {error}"
            connection.rollback()
        finally:
            connection.close()
        return {
            "phase": phase,
            "result": result,
            "original": marker(parent / "original-source" / "opencode.db"),
            "replacement": marker(source / "opencode.db"),
        }


if __name__ == "__main__":
    print(json.dumps({"sqlite": sqlite3.sqlite_version}))
    for phase in ("before_begin", "after_begin", "after_write"):
        print(json.dumps(probe(phase)))
```

## C API：ABA、sidecar 身分、HAS_MOVED 與 NOFOLLOW

旗標數值對應官方 SQLITE_OPEN_READWRITE／CREATE／NOFOLLOW、SQLITE_FCNTL_HAS_MOVED／PERSIST_WAL；只為重現固定合成實驗，不是 production binding。所有 CREATE 僅用於剛建立的暫存目錄。

```python
"""Synthetic-only audit. No input paths; every DB created under TemporaryDirectory."""
import ctypes as C, ctypes.util, pathlib as P, tempfile, json
s=C.CDLL(ctypes.util.find_library('sqlite3'))
s.sqlite3_open_v2.argtypes=[C.c_char_p,C.POINTER(C.c_void_p),C.c_int,C.c_char_p]
s.sqlite3_exec.argtypes=[C.c_void_p,C.c_char_p,C.c_void_p,C.c_void_p,C.POINTER(C.c_char_p)]
s.sqlite3_file_control.argtypes=[C.c_void_p,C.c_char_p,C.c_int,C.c_void_p]
s.sqlite3_close.argtypes=[C.c_void_p]
s.sqlite3_errmsg.argtypes=[C.c_void_p];s.sqlite3_errmsg.restype=C.c_char_p
s.sqlite3_libversion.restype=C.c_char_p
CB=C.CFUNCTYPE(C.c_int,C.c_void_p,C.c_int,C.POINTER(C.c_char_p),C.POINTER(C.c_char_p))
class DB:
 def __init__(self,p,create=False):
  self.h=C.c_void_p();rc=s.sqlite3_open_v2(str(p).encode(),C.byref(self.h),2|0x01000000|(4 if create else 0),None)
  if rc: raise RuntimeError(('open',rc,s.sqlite3_errmsg(self.h).decode()))
 def sql(self,q):
  rows=[]
  @CB
  def cb(_,n,v,k): rows.append([v[i].decode() if v[i] else None for i in range(n)]);return 0
  rc=s.sqlite3_exec(self.h,q.encode(),C.cast(cb,C.c_void_p),None,None)
  if rc: raise RuntimeError((rc,s.sqlite3_errmsg(self.h).decode()))
  return rows
 def moved(self):
  v=C.c_int(-1);rc=s.sqlite3_file_control(self.h,b'main',20,C.byref(v));return [rc,v.value]
 def close(self): s.sqlite3_close(self.h)
def stamp(p):
 st=p.stat();return [st.st_dev,st.st_ino]
def setup(p,value):
 d=DB(p,True);d.sql('CREATE TABLE marker(id TEXT PRIMARY KEY,value TEXT);');d.sql(f"INSERT INTO marker VALUES('same-session-id','{value}');");d.sql('PRAGMA journal_mode=WAL');d.sql('BEGIN IMMEDIATE');d.sql('COMMIT');v=C.c_int(1);s.sqlite3_file_control(d.h,b'main',10,C.byref(v));d.close()
def read(p):
 d=DB(p);r=d.sql('SELECT * FROM marker');d.close();return r
def case(phase,guard):
 with tempfile.TemporaryDirectory(prefix='sessionbay-synthetic-guard-') as t:
  root=P.Path(t);a=root/'source';b=root/'replacement';a.mkdir();b.mkdir();setup(a/'d.db','original');setup(b/'d.db','replacement')
  expected=[stamp(a),*[stamp(a/n) if (a/n).exists() else None for n in ['d.db','d.db-wal','d.db-shm']]];d=DB(a/'d.db');deleted=False;checks=None
  def swap(): a.rename(root/'original');b.rename(a)
  if phase in ('before_begin','aba'): swap()
  try:
   d.sql('BEGIN IMMEDIATE')
   if phase=='aba':
    a.rename(b);(root/'original').rename(a)
   if phase=='after_begin': swap()
   checks={'expected':expected,'identity':[stamp(a),*[stamp(a/n) if (a/n).exists() else None for n in ['d.db','d.db-wal','d.db-shm']]]==expected,'moved':d.moved(),'content':d.sql('SELECT * FROM marker')}
   ok=checks['identity'] and checks['moved']==[0,0] and checks['content']==[['same-session-id','original']]
   if guard and not ok: d.sql('ROLLBACK')
   else:
    if phase=='after_guard': swap()
    d.sql("DELETE FROM marker WHERE id='same-session-id'");d.sql('COMMIT');deleted=True
   status='ok'
  except Exception as e:
   status=str(e)
   try:d.sql('ROLLBACK')
   except:pass
  finally:d.close()
  return {'phase':phase,'guard':guard,'checks':checks,'delete_executed':deleted,'status':status,'original':read((root/'original' if (root/'original').exists() else a)/'d.db'),'replacement':read((b if phase=='aba' else a)/'d.db')}
print(json.dumps({'sqlite':s.sqlite3_libversion().decode()}))
for p in ['aba']:
 for g in [False,True]: print(json.dumps(case(p,g)))
with tempfile.TemporaryDirectory(prefix='sessionbay-synthetic-nofollow-') as t:
 p=P.Path(t);(p/'real').mkdir();setup(p/'real/d.db','original');(p/'alias').symlink_to(p/'real',target_is_directory=True)
 try:d=DB(p/'alias/d.db');print('NOFOLLOW incorrectly accepted symlink');d.close()
 except Exception as e:print('NOFOLLOW ancestor symlink rejected:',e)
```

## Python：ABA 與禁 close checkpoint

```python
"""Synthetic-only audit: accepts no paths and uses temporary marker databases."""
import pathlib as P, tempfile, json
import sqlite3
class DB:
 def __init__(self,p,create=False):
  self.h=sqlite3.connect(p,isolation_level=None)
  self.h.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,True)
 def sql(self,q):return [list(r) for r in self.h.execute(q)]
 def moved(self):return 'unavailable in Python; path identities checked'
 def close(self):self.h.close()
def stamp(p):
 st=p.stat();return [st.st_dev,st.st_ino]
def setup(p,value):
 d=DB(p,True);d.sql('CREATE TABLE marker(id TEXT PRIMARY KEY,value TEXT);');d.sql(f"INSERT INTO marker VALUES('same-session-id','{value}');");d.sql('PRAGMA journal_mode=WAL');d.sql('BEGIN IMMEDIATE');d.sql('COMMIT');d.close()
def read(p):
 d=DB(p);r=d.sql('SELECT * FROM marker');d.close();return r
def case(phase,guard):
 with tempfile.TemporaryDirectory(prefix='sessionbay-synthetic-guard-') as t:
  root=P.Path(t);a=root/'source';b=root/'replacement';a.mkdir();b.mkdir();setup(a/'d.db','original');setup(b/'d.db','replacement')
  expected=[stamp(a),*[stamp(a/n) if (a/n).exists() else None for n in ['d.db','d.db-wal','d.db-shm']]];d=DB(a/'d.db');deleted=False;checks=None
  def swap(): a.rename(root/'original');b.rename(a)
  if phase in ('before_begin','aba'): swap()
  try:
   d.sql('BEGIN IMMEDIATE')
   if phase=='aba':
    a.rename(b);(root/'original').rename(a)
   if phase=='after_begin': swap()
   checks={'expected':expected,'identity':[stamp(a),*[stamp(a/n) if (a/n).exists() else None for n in ['d.db','d.db-wal','d.db-shm']]]==expected,'moved':d.moved(),'content':d.sql('SELECT * FROM marker')}
   ok=checks['identity'] and checks['content']==[['same-session-id','original']]
   if guard and not ok: d.sql('ROLLBACK')
   else:
    if phase=='after_guard': swap()
    d.sql("DELETE FROM marker WHERE id='same-session-id'");d.sql('COMMIT');deleted=True
   status='ok'
  except Exception as e:
   status=str(e)
   try:d.sql('ROLLBACK')
   except:pass
  finally:d.close()
  return {'phase':phase,'guard':guard,'checks':checks,'delete_executed':deleted,'status':status,'original':read((root/'original' if (root/'original').exists() else a)/'d.db'),'replacement':read((b if phase=='aba' else a)/'d.db')}
print(json.dumps({'sqlite':sqlite3.sqlite_version}))
for p in ['aba']:
 for g in [False,True]: print(json.dumps(case(p,g)))
```
