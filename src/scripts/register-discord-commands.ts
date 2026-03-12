#!/usr/bin/env node
/**
 * Registers slash commands with Discord.
 *
 * Global (default):
 *   npx tsx src/scripts/register-discord-commands.ts
 *   — Takes up to 1 hour to propagate.
 *
 * Guild (instant, your server only):
 *   DISCORD_GUILD_ID=<your-server-id> npx tsx src/scripts/register-discord-commands.ts
 *   — Right-click server name in Discord → Copy Server ID (requires Developer Mode)
 *
 * Required env vars: DISCORD_BOT_TOKEN, DISCORD_APP_ID
 */

process.loadEnvFile(new URL('../../.env', import.meta.url));

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !appId) {
  console.error('❌  DISCORD_BOT_TOKEN and DISCORD_APP_ID must be set in .env');
  process.exit(1);
}

const clearGlobal = process.argv.includes('--clear-global');

const commands = clearGlobal ? [] : [
  {
    name: 'docker-check',
    description: 'Run a Docker container update check and auto-apply safe updates',
    default_member_permissions: null,
  },
  {
    name: 'clear',
    description: 'Delete all messages in this channel and reset bot memory',
    default_member_permissions: null,
  },
];

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

if (clearGlobal) {
  console.log('🗑️  Clearing all global commands...');
} else {
  console.log(guildId ? `📡  Registering guild commands (instant) for guild ${guildId}...` : '📡  Registering global commands...');
}

const res = await fetch(url, {
  method: 'PUT',
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
if (clearGlobal) {
  console.log('✅  All global commands cleared.');
} else {
  console.log('✅  Registered commands:');
  for (const cmd of registered) {
    console.log(`   /${cmd.name}  (id: ${cmd.id})`);
  }
}
if (!guildId && !clearGlobal) {
  console.log('\n⚠️  Global commands can take up to 1 hour to propagate.');
  console.log('    For instant testing: DISCORD_GUILD_ID=<id> npx tsx src/scripts/register-discord-commands.ts');
}

export {};
