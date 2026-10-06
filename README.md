# Quiz Room

A no-login quiz app for your office. Make a quiz, share the link on WhatsApp,
people type their name and play. You see a leaderboard and everyone's full answer sheet.

## Run it (on one office computer)

1. Install Node.js 18 or newer.
2. In this folder:
   ```
   npm install
   npm start
   ```
   To use your own admin PIN (default is 1234):
   ```
   ADMIN_PIN=4321 npm start          # Mac / Linux / Git Bash
   set ADMIN_PIN=4321&& npm start    # Windows CMD
   ```
3. The terminal prints an "On office Wi-Fi" address like `http://192.168.1.19:4000`.
   Open it, click **Create quizzes**, enter the PIN.

Colleagues' phones/laptops must be on the same Wi-Fi as this computer.
If Windows asks about the firewall the first time, click **Allow**.

## Question types

- **Multiple choice**: question + optional code snippet + 2 to 6 options.
- **Type the output**: they type what the program prints. Spaces and line breaks
  are treated the same when checking.

You can also paste many questions at once as JSON (format shown in the quiz editor).

## Where data lives

- **Locally:** `quiz-data.json` next to `server.js`. Back it up to keep results.
- **On Vercel:** Upstash Redis (set automatically when the env vars below exist).

Coming from the old version? Run `node migrate.js` once to copy `data.json` into the
current store (run it with the Upstash env vars set to copy into Redis instead).

## Host it free on Vercel + Upstash Redis

1. Push this folder to a GitHub repo, then on vercel.com: **Add New → Project**, import it.
   No build settings needed.
2. In the project: **Storage → Create → Upstash for Redis** (free plan), connect it to the
   project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Settings → Environment Variables:** add `ADMIN_PIN` with your own PIN.
4. **Deployments → Redeploy** so the new variables are picked up.
5. Optional, to bring old results over: copy those two variables from Vercel, then locally
   `KV_REST_API_URL=... KV_REST_API_TOKEN=... node migrate.js`.

The leaderboard refreshes every 15 seconds; the free Upstash plan (500k commands a month)
covers a team of a few dozen people comfortably.

Run `npm test` to check everything still works (uses a temporary local file, never Redis).
