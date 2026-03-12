---
agent: 'agent'
description: 'Register Discord slash commands for the Unraid prod bot (guild-scoped, instant)'
---

# Register Prod Discord Slash Commands

Your task is to register the current slash commands with the **Unraid production Discord bot** using guild-scoped registration (instant propagation).

This is run from the Mac, overriding the local `.env` (which holds dev bot credentials) by passing prod credentials inline.

## Step 1 — Collect prod credentials

Ask the user to provide the following values. Tell them exactly where to find each one:

> "I need two credentials from your Unraid prod bot to register the commands. Please share:
>
> 1. **`DISCORD_BOT_TOKEN`** — your prod bot token
>    *(Discord Developer Portal → your prod app → Bot → Token)*
> 2. **`DISCORD_APP_ID`** — your prod application ID
>    *(Discord Developer Portal → your prod app → General Information → Application ID)*
>
> Note: `DISCORD_GUILD_ID` is your Discord server ID — the same for both dev and prod bots — so it's read from your local `.env` automatically.
>
> These will ONLY be used to construct the terminal command below and will not be stored anywhere."

Wait for both values before proceeding.

## Step 2 — Permission check

Before running anything, show the user the exact command that will be executed and ask for approval:

> "I'll run this command from the project root. It overrides the local `.env` dev bot token and app ID with your prod values inline — the `.env` file itself is never modified. `DISCORD_GUILD_ID` is the same server for both bots, so it's used from `.env` as-is:
>
> ```bash
> TOKEN=<DISCORD_BOT_TOKEN> APP_ID=<DISCORD_APP_ID> make register-prod-guild
> ```
>
> **May I run this now?**"

Wait for explicit approval ("yes", "ok", "go ahead", etc.) before proceeding.

## Step 3 — Run the command

Run the command from the project root (`/Users/adamshappy/code/misc/my-mastra-app`), substituting the actual provided values:

```bash
TOKEN=<value> APP_ID=<value> make register-prod-guild
```

## Step 4 — Report results

- On success: show the list of registered commands and confirm they are **guild-scoped (instant)** — no propagation delay.
- On failure: show the raw error and suggest likely causes (wrong token, bot not in server, missing permissions).

## Security reminder

Do not echo the raw token back to the user in any message after Step 2. If the command output contains the token, redact it before displaying.
