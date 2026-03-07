#!/usr/bin/env node
/**
 * One-time script to register the /docker-check slash command with Discord.
 *
 * Run this once after creating your Discord app / bot:
 *
 *   npx tsx src/scripts/register-discord-commands.ts
 *
 * Required env vars (set in .env before running):
 *   DISCORD_BOT_TOKEN
 *   DISCORD_APP_ID
 *
 * Global commands take up to 1 hour to propagate to all servers.
 * For faster testing, register as a guild command instead — swap the URL below
 * to: /applications/{appId}/guilds/{guildId}/commands
 */

import 'dotenv/config';

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;

if (!token || !appId) {
  console.error('❌  DISCORD_BOT_TOKEN and DISCORD_APP_ID must be set in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'docker-check',
    description: 'Run a Docker container update check and auto-apply safe updates',
    default_member_permissions: null, // visible to everyone — restrict in Discord server settings if needed
  },
];

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const res = await fetch(url, {
  method: 'PUT', // PUT replaces all global commands atomically
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bot ${token}`,
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  const text = await res.text();
  console.error(`❌  Failed to register commands: ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

const registered = await res.json() as { name: string; id: string }[];
console.log('✅  Registered commands:');
for (const cmd of registered) {
  console.log(`   /${cmd.name}  (id: ${cmd.id})`);
}
console.log('\n⚠️  Global commands can take up to 1 hour to propagate.');
console.log('    For instant testing, use guild commands (see script comment).');
