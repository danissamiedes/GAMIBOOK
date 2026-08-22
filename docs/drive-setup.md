# Watching a Google Drive folder

New photos in a Drive folder appear in **Files → Receipt inbox** by themselves.
They are **linked, not copied**: the queue holds a pointer and Drive keeps the
only picture, so the Drive link is what you click to look at a receipt — and
deleting the file in Drive removes the evidence behind any expense it became.

Access is a **service account**: a robot Google identity you share one folder
with. It sees that folder and nothing else in anyone's Drive. That is the
reason for the extra setup — the alternative, connecting your own account,
would need the `drive.readonly` scope, which means the whole of your Drive.

## 1. Create the service account

In the [Google Cloud console](https://console.cloud.google.com/), in the same
project as the Gmail client:

1. **APIs & Services → Library** → enable the **Google Drive API**.
2. **IAM & Admin → Service accounts → Create service account**.
   - Name: `gamibook-drive`. Skip the optional role and access steps — it needs
     no project permissions at all; its access comes entirely from what you
     share with it.
3. Open the account → **Keys → Add key → Create new key → JSON**. The file
   downloads once.

Note the account's email, which looks like
`gamibook-drive@your-project.iam.gserviceaccount.com`.

## 2. Give it the key

In Vercel, **Settings → Environment Variables**, add
`GOOGLE_DRIVE_SERVICE_ACCOUNT` marked **Sensitive**, with either:

- the whole contents of the JSON file, or
- a base64 copy of it, if pasting multi-line JSON gives trouble:
  `base64 -w0 gamibook-drive-....json`

Both are accepted. Redeploy.

## 3. Share the folder

In Drive, right-click the receipts folder → **Share** → paste the service
account's email → **Viewer** → Send. Google may warn that the address is
outside your organisation; that is expected for a service account.

**Settings → Google Drive** in GAMIBOOK shows the exact address to share with,
so you can copy it from there rather than retyping it.

## 4. Point GAMIBOOK at it

**Files → Google Drive** → paste the folder's URL from your browser's address
bar → **Watch this folder**. The folder is checked immediately, so a mistake
fails here rather than producing an empty queue for a week.

From then on it is checked about every 15 minutes, and **Check now** forces a
scan.

## If something goes wrong

| What you see | What it means |
| --- | --- |
| "That folder was not found" | The folder ID is wrong, or the folder is not shared with the service account |
| "Google refused access to that folder" | Shared with the wrong address, or the share has not propagated — wait a minute and retry |
| "not valid JSON" | The key was pasted partially. Paste the whole file, or use the base64 form |
| "could not sign a request" | The `private_key` lost its newlines in transit. Use the base64 form |
| Nothing appears after adding a photo | Only images are picked up, and only from the folder itself — not from subfolders |

## What it does not do

- **Subfolders are not scanned.** One folder, its own files.
- **Only images.** A PDF in the folder is ignored.
- **Nothing is deleted or moved in Drive.** The service account is a Viewer and
  the app never writes.
- **A file removed from Drive disappears from view.** The queue row and any
  expense remain, but the link goes nowhere. If that matters more than the
  storage saved, say so and the sync can keep a copy instead.
