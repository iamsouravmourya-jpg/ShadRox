const fs = require('node:fs/promises');
const path = require('node:path');

function createMachineGit({ run, context, getWorkspace }) {
  async function command(root, args, safety, input) {
    return run(root, args, safety, input);
  }

  async function read(id) {
    const root = getWorkspace(id)?.root;
    if (!root) return null;
    const safety = await context(root);
    if (!safety.complete) return null;
    const top = await command(root, ['rev-parse', '--show-toplevel'], safety);
    if (!top.ok) return null;
    const head = await command(root, ['rev-parse', '--verify', 'HEAD'], safety);
    const branch = await command(root, ['symbolic-ref', '-q', 'HEAD'], safety);
    const status = await command(root, ['status', '--porcelain=v1', '--untracked-files=normal'], safety);
    const staged = await command(root, ['ls-files', '--stage', '-z'], safety);
    const tree = head.ok ? await command(root, ['ls-tree', '-r', '-z', 'HEAD'], safety) : null;
    if (!status.ok || !staged.ok || (head.ok && !tree?.ok)) throw new Error('Git snapshot could not be completed.');
    const entries = (text) => Object.fromEntries(text.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t');
      return [entry.slice(tab + 1), entry.slice(0, tab)];
    }));
    let index = null;
    const gitDir = path.join(root, '.git');
    const stat = await fs.lstat(gitDir).catch(() => null);
    if (path.resolve(top.stdout.trim()) === root && stat?.isDirectory() && !stat.isSymbolicLink()) {
      const indexPath = path.join(gitDir, 'index');
      const indexStat = await fs.lstat(indexPath).catch(() => null);
      if (indexStat?.isFile() && !indexStat.isSymbolicLink() && indexStat.nlink === 1 && indexStat.size <= 4 * 1024 * 1024) {
        index = (await fs.readFile(indexPath)).toString('base64');
      }
    }
    return { head: head.ok ? head.stdout.trim() : null, ref: branch.ok ? branch.stdout.trim() : null,
      status: status.stdout, index, staged: entries(staged.stdout), tree: entries(tree?.stdout ?? '') };
  }

  async function prepare(id, before, expected) {
    const root = getWorkspace(id)?.root;
    if (!root || !before?.index || !expected?.index || before.ref !== expected.ref || !/^refs\/heads\/[^\s]+$/.test(before.ref ?? '') || !/^[a-f0-9]{40,64}$/.test(before.head ?? '') || !/^[a-f0-9]{40,64}$/.test(expected.head ?? '')) throw new Error('Git state is not safely reversible.');
    const current = await read(id);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Git changed before rewind.');
    const gitDirectory = path.join(root, '.git');
    const directoryStat = await fs.lstat(gitDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || path.resolve(await fs.realpath(gitDirectory)) !== path.resolve(gitDirectory)) throw new Error('Unsafe Git directory.');
    const safety = await context(root);
    const indexPath = path.join(root, '.git', 'index');
    const indexLock = `${indexPath}.lock`;
    const headLock = path.join(root, '.git', 'HEAD.lock');
    let indexHandle;
    let headHandle;
    let indexOwned = false;
    let headOwned = false;
    const release = async () => {
      await indexHandle?.close(); indexHandle = null;
      await headHandle?.close(); headHandle = null;
      if (indexOwned) { await fs.rm(indexLock, { force: true }); indexOwned = false; }
      if (headOwned) { await fs.rm(headLock, { force: true }); headOwned = false; }
    };
    try {
      headHandle = await fs.open(headLock, 'wx', 0o600); headOwned = true;
      indexHandle = await fs.open(indexLock, 'wx', 0o600); indexOwned = true;
      if (JSON.stringify(await read(id)) !== JSON.stringify(expected)) throw new Error('Git changed while acquiring rewind locks.');
      await indexHandle.writeFile(Buffer.from(before.index, 'base64'));
      await indexHandle.sync();
      await indexHandle.close(); indexHandle = null;
    } catch (error) { await release(); throw error; }
    return {
      abort: release,
      async commit() {
        const ref = await command(root, ['symbolic-ref', '-q', 'HEAD'], safety);
        if (!ref.ok || ref.stdout.trim() !== expected.ref || (await fs.readFile(indexPath)).toString('base64') !== expected.index) throw new Error('Git changed during rewind.');
        const moved = before.head !== expected.head;
        if (moved) {
          // Git rejects a transaction that combines symref-verify HEAD with an update
          // to the verified referent (multiple updates for 'HEAD') and it takes its own
          // HEAD.lock for any referent update, so no single update-ref transaction can
          // both verify the branch and rewind it. While our HEAD.lock was held nothing
          // could move HEAD, so the checks above are race-free up to this release; the
          // branch itself is then protected by the value compare-and-swap and a
          // same-branch re-verify closes the symref window by rolling the ref back.
          await headHandle.close(); headHandle = null;
          await fs.rm(headLock); headOwned = false;
          const result = await command(root, ['update-ref', '--no-deref', '-m', 'ShadRox approved machine rewind', expected.ref, before.head, expected.head], safety);
          if (!result.ok) throw new Error('Git branch position changed during rewind; compare-and-swap failed.');
          const branch = await command(root, ['symbolic-ref', '-q', 'HEAD'], safety);
          if (!branch.ok || branch.stdout.trim() !== expected.ref) {
            const undone = await command(root, ['update-ref', '--no-deref', '-m', 'ShadRox rewind recovery', expected.ref, expected.head, before.head], safety);
            if (!undone.ok) throw new Error('Git rewind failed; manual ref recovery is required.');
            throw new Error('Git changed during rewind.');
          }
        }
        try {
          await fs.rename(indexLock, indexPath);
          indexOwned = false;
        } catch (error) {
          if (moved) {
            const undone = await command(root, ['update-ref', '-m', 'ShadRox rewind recovery', before.ref, expected.head, before.head], safety);
            if (!undone.ok) throw new Error('Git rewind failed; manual ref recovery is required.');
          }
          throw error;
        }
      }
    };
  }

  return { read, prepare };
}

module.exports = { createMachineGit };
