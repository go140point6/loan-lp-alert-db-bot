# GitHub Workflow Cheat Sheet (Solo Repo)

This repo uses a simple **dev → main** promotion model.

- **`dev`** = working / staging branch
- **`main`** = production branch (what runs on prod)
- I am the only contributor
- Commit history cleanliness is *not* a priority; correctness and simplicity are

---

## Normal Development Flow

1. Work on `dev`
   ```bash
   git checkout dev
   # make changes
   git add .
   git commit -m "<message>"
   git push origin dev
   ```

2. Test / stage changes locally or on staging

---

## Promote `dev` → `main` (Release)

1. Open GitHub
2. Click **Compare & pull request** (base: `main`, compare: `dev`)
3. Create the PR
4. **Squash and merge** the pull request
   - This creates a single clean commit on `main`
5. Do **not** delete the `dev` branch

---

## Deploy to Production

On the production server:

```bash
git checkout main
git pull origin main
# restart service / bot
```

---

## IMPORTANT: Sync `dev` After Every Merge

After *every* merge into `main`, sync `dev` so it never falls behind.

Run locally:

```bash
git checkout dev
git fetch origin
git merge origin/main
git push origin dev

or

one-time add: git config --global alias.sync-dev '!git checkout dev && git fetch origin && git merge --no-edit origin/main && git push origin dev'

then git sync-dev
```

This keeps:
- `dev` always **level with or ahead of** `main`
- GitHub from showing confusing "dev is behind main" messages

---

## Golden Rules

- **Never commit directly to `main`**
- Always develop in `dev`
- Always squash-merge PRs into `main`
- Always sync `main` → `dev` after merging

---

## Mental Model

> `dev` is the workspace
> `main` is production
> After promotion, bring `dev` back in sync

If something looks weird: `git fetch` + `git log origin/dev..origin/main` will explain it.

