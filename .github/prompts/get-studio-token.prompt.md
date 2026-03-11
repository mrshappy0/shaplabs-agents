---
agent: 'agent'
description: 'Generate a bearer token for accessing Mastra Studio at http://192.168.1.195:4111/studio'
---

# Get Mastra Studio Bearer Token

Your task is to generate a signed JWT bearer token so the user can access Mastra Studio at `http://192.168.1.195:4111/studio`.

## Permission check — REQUIRED before running anything

Before taking any action, ask the user:

> "To generate the Mastra Studio bearer token I need to run a terminal command that reads `MASTRA_JWT_SECRET` from your `.env` file and signs a JWT with it.
> 
> **May I run the following command?**
> ```
> node -e "const fs=require('fs'),jwt=require('./node_modules/.pnpm/jsonwebtoken@9.0.3/node_modules/jsonwebtoken');const s=fs.readFileSync('.env','utf8').match(/^MASTRA_JWT_SECRET=(.+)$/m)[1].trim();console.log('Bearer '+jwt.sign({role:'admin',sub:'studio-user'},s,{expiresIn:'365d'}))"
> ```
> This reads `.env` and generates a 1-year JWT — the secret is never printed, only the signed token."

Wait for explicit approval ("yes", "ok", "go ahead", etc.) before proceeding.

## After approval

Run this command from the project root (`/Users/adamshappy/code/misc/my-mastra-app`):

```bash
node -e "const fs=require('fs'),jwt=require('./node_modules/.pnpm/jsonwebtoken@9.0.3/node_modules/jsonwebtoken');const s=fs.readFileSync('.env','utf8').match(/^MASTRA_JWT_SECRET=(.+)$/m)[1].trim();console.log('Bearer '+jwt.sign({role:'admin',sub:'studio-user'},s,{expiresIn:'365d'}))"
```

## After running

Present the output as a copyable code block labeled **Bearer Token**, then show these usage instructions:

### How to use

**Browser (Mastra Studio)**
1. Open **http://192.168.1.195:4111/studio** in your browser
2. In the **Mastra Instance URL** field, enter: `http://192.168.1.195:4111`
3. Under **Headers**, add an entry:
   - **Name / Key:** `Authorization`
   - **Value:** the full `Bearer eyJ...` token above
4. Click **Set Configuration** — Studio will connect authenticated

**curl**
```bash
curl -H "Authorization: <paste token here>" http://192.168.1.195:4111/api/agents
```

**VS Code REST Client / Insomnia / Postman**
```
Authorization: <paste token here>
```

> Token expires in **365 days**. Re-run this prompt to regenerate it.
