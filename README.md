# Nightly lead import for RogoFX_Lead_Tracker (replaces the Make scenario)

Monday to Saturday at about 1:40am Chicago time (2:40am in summer), GitHub Actions runs this job. It doesn't run on Sunday. It doesn't need Make or a server, and your computer can be off.

## What it does each night

1. Counts how many leads were already added to **Master Leads** today. It will add 1,000 minus that number.
2. Goes down the **Coverage Log** from the top. It picks up every row marked `Not run`, plus the rows Make left on `Processing`.
3. Runs the Apify Google Maps scraper with that row's **Keyword** and **Location**. There's no limit on how many places it returns.
4. Skips anyone it shouldn't contact:
   - places with no phone number, or listed as closed
   - anyone on **Do Not Contact**
   - anyone already in **Master Leads** (matched on phone number)
   - anyone already in GHL
   - categories you marked **No** on the **Categories** tab, such as parks and plant nurseries
5. Creates everyone else in GHL with the same fields Make used: first name and company name (with LLC/Inc removed), phone, address, city, state and website. Then it puts each one in the **SMS Pipeline**, stage **New Prospect**, named after the business, as Make did. Landing in that stage is what starts the **Initial SMS Sequence (Add Leads Here)** workflow. The pipeline and stage are set in `config.json` under `ghl.opportunity`.
6. Adds each new lead to **Master Leads**.
7. Marks the Coverage Log row `Run`, with Date run, Results returned and a short note.
8. Stops at **1,000 new contacts** for the day.

The **Dashboard** tab updates by itself. "Counties run" counts the Coverage Log rows marked Run, and the funnel counts the rows in Master Leads.

### Leads already paid for come first (the paid backlog)

Make's old scrapes (October to 12 November) are saved in Apify as the dataset `rogofx-paid-backlog`: 10,031 businesses with a phone, after removing duplicates, closed places and anyone already in Master Leads. Every night the job works through that list **before scraping anything new**:

- Each lead gets the same checks as a new scrape: Do Not Contact, Master Leads, the Categories tab and a GHL duplicate check. Most of these businesses are probably in GHL already, so many are skipped.
- New ones are created in GHL and added to Master Leads with the Coverage Log row's state, county and keyword, and the note `Auto import (paid backlog)`.
- It stops at the daily limit and carries on from the same place the next night. Its place is saved in the Apify key-value store `rogofx-paid-backlog-state`.
- Nights spent on the backlog cost nothing in Apify. When the list runs out, that same night carries on with Coverage Log scraping as described above. The run report says how many backlog leads are left.
- The Coverage Log isn't changed for backlog leads, because their counties are already marked Run.
- To skip the backlog, delete the `backlog` block from `config.json`.

### Never paying Apify twice for the same county

- As soon as a scrape finishes, its row is marked `Partial` and the Apify dataset ID is saved in Notes.
- If the job reaches 1,000 partway through a county, or crashes, the next night finishes that county from the saved results instead of scraping it again.
- To save time, it scrapes up to 3 counties at once. Any that are left over at the end of the night are saved the same way.
- Rows you marked `Partial` by hand (with no saved dataset) are left alone, just as Make leaves them.

## One-time setup

### 1. Google: let the job read and write the sheet

1. Go to <https://console.cloud.google.com> and create a project (any name).
2. Go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
3. Go to **IAM & Admin → Service Accounts → Create service account**. Any name works, and you can skip the roles step.
4. Open the new service account and go to **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. Open **RogoFX_Lead_Tracker**, click **Share**, and paste the service account's email address (it ends in `iam.gserviceaccount.com` and is listed as `client_email` in the JSON file). Give it **Editor** access.

### 2. GoHighLevel and Apify

- **GHL token:** in the sub-account, go to **Settings → Private Integrations → Create new integration**. Give it the **View Contacts**, **Edit Contacts**, **View Opportunities** and **Edit Opportunities** scopes, then copy the token.
- **GHL location ID:** the part after `/location/` in your GHL web address.
- **Apify token:** in the Apify Console, go to **Settings → API & Integrations** and copy the token.

### 3. GitHub

1. Create a repository at <https://github.com/new>. Expect a night to take around an hour, mostly waiting for Apify. That gives you two choices:
   - **Public repository:** unlimited free minutes. Your tokens are stored as secrets, so nobody can see them, but anyone can read the code.
   - **Private repository:** 2,000 free minutes a month, which a month of nightly runs can go over. By default GitHub then stops running jobs until the next month. To prevent that, set a small spending limit (a few dollars) under **Settings → Billing**.
2. Upload every file in this folder, including the hidden `.github` folder. In Finder, press **Cmd+Shift+.** to show hidden files. Don't upload a `.env` file or your Google JSON key.
3. In the repository, go to **Settings → Secrets and variables → Actions → New repository secret** and add each of these:

| Secret | Value |
|---|---|
| `SHEET_ID` | The sheet's link (the job pulls the ID out of it) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The entire contents of the downloaded JSON key file |
| `APIFY_TOKEN` | Apify token |
| `GHL_TOKEN` | GHL Private Integration token |
| `GHL_LOCATION_ID` | GHL location ID |

`GHL_WORKFLOW_ID` is optional. Leave it out, because Make never added contacts to a workflow; your GHL trigger does that.

## Switching over from Make

1. **Dry run:** go to **Actions → Nightly lead import → Run workflow**, leave **Dry run** ticked, and run it. This only reads the sheet. It shows today's budget, how many rows are waiting, and the next 5 rows it would scrape.
2. **Small real run:** run the workflow again with **Dry run** unticked, **limit** `5` and **max locations** `1`. These 5 are real leads, and GHL will text them as on any normal night. Then check:
   - the 5 contacts appear in GHL and the SMS workflow starts for them
   - 5 new rows appear at the bottom of Master Leads
   - the Coverage Log row shows `Run` (or `Partial`), and the Dashboard has updated
3. **Go live:** the nightly schedule stays off until you switch it on, so it can't run alongside Make by accident.
   1. Turn off the Make scenario. Don't run both, or they'll scrape and create contacts twice.
   2. In the repository, go to **Settings → Secrets and variables → Actions → Variables → New repository variable**. Name it `NIGHTLY_ENABLED` and set it to `true`.

   From then on, the job runs Monday to Saturday by itself.

## Day to day

- **What happened last night:** look at the Dashboard, the Coverage Log Notes, or the run on the **Actions** page.
- **Problems:** if a run fails, GitHub emails you. That includes running out of `Not run` rows before reaching 1,000.
- **Change the time:** edit the `cron` line in `.github/workflows/nightly.yml`. It's in UTC, so `37 7 * * 1-6` is 1:37am CST, Monday (1) to Saturday (6). Use `37 7 * * *` to run every day. Keep the minute off `:00`: GitHub's queue is busiest on the hour, and the 08:00 slot started 8½ hours late on 12 November.
- **Apify spending limit:** each run prints this month's Apify spend. If the limit is used up (or less than `apify.stopBelowUsd` is left), the run stops before scraping, says how much is used and when it resets, and GitHub emails you. Nothing in the sheet or GHL changes. Raise the limit at <https://console.apify.com/billing/limits> or wait for the reset.
- **Pause it:** change the `NIGHTLY_ENABLED` variable to `false`. Manual runs from the Actions page still work while it's paused.

## Settings (`config.json`)

| Setting | Now | What it does |
|---|---|---|
| `dailyLimit` | 1000 | The most new contacts per day |
| `apify.parallelRuns` | 3 | How many counties are scraped at once |
| `backlog` | Make's paid scrapes | The Apify dataset worked through before any new scraping (see "Leads already paid for come first") |
| `apify.stopBelowUsd` | 3 | Don't start another scrape when less than this many dollars of the Apify monthly limit is left, so a county isn't cut off halfway and still billed |
| `masterLeads.status` | Texted | The Status written on new Master Leads rows. The Dashboard counts these under "Texted". |
| `skipClosedPlaces` | true | Skips businesses Google lists as closed. This is checked here, after the scrape: Apify's own "skip closed places" filter is billed on every place, so it isn't used |

## Running it on your own computer (optional)

You'll need Node 22 or later. Copy `.env.example` to `.env`, fill it in, and put the Google JSON key next to it as `service-account.json`. Then:

```bash
npm run dry-run
```

```bash
npm test
```

## Costs

- **GitHub Actions:** free for a public repository. A private repository may run a few dollars over its free minutes (see the GitHub step above).
- **Apify:** billed per place scraped, about $3–4 per 1,000 places depending on your Apify plan, plus a few cents a run. Many places are skipped (no phone, already contacted), so 1,000 new contacts can take 2,000–3,000 places: roughly $6–12 a night, or $150–300 over a month of Monday-to-Saturday runs. An $80 monthly limit covers about a week to ten days. With no place limit, big counties return more places and cost more, but every place is used: whatever isn't processed tonight is saved for tomorrow.
- **GHL:** no extra cost.
