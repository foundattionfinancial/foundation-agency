const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseAllAmounts(content) {
  const amounts = [];
  const regex = /\$?([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\$?/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1].replace(/,/g, '');
    const num = parseFloat(raw);
    if (!isNaN(num) && num >= 100 && num <= 50000) {
      amounts.push(num);
    }
  }
  return amounts;
}

async function backfill(channel) {
  console.log('🔄 Starting backfill...');
  let before = null;
  let total = 0;
  let processed = 0;

  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    for (const message of messages.values()) {
      if (message.author.bot) continue;
      const amounts = parseAllAmounts(message.content);
      if (amounts.length === 0) continue;

      await supabase.from('users').upsert({
        discord_id: message.author.id,
        username: message.author.username,
        display_name: message.member?.displayName || message.author.username,
        avatar: message.author.displayAvatarURL(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'discord_id' });

      for (let i = 0; i < amounts.length; i++) {
        const { error } = await supabase.from('deals').insert({
          discord_id: message.author.id,
          amount: amounts[i],
          message_id: `${message.id}-${i}`,
          message_url: message.url,
          posted_at: message.createdAt.toISOString(),
        });
        if (!error) total++;
      }
      processed++;
    }

    console.log(`📦 Processed ${processed} messages, ${total} deals logged...`);
    before = messages.last().id;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`✅ Backfill complete! ${total} deals logged.`);
}

discord.on('ready', async () => {
  console.log(`✅ Foundation Bot online as ${discord.user.tag}`);

  // Run backfill on startup
  const channel = await discord.channels.fetch(process.env.DEAL_CHANNEL_ID);
  await backfill(channel);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== process.env.DEAL_CHANNEL_ID) return;

  const amounts = parseAllAmounts(message.content);
  if (amounts.length === 0) return;

  await supabase.from('users').upsert({
    discord_id: message.author.id,
    username: message.author.username,
    display_name: message.member?.displayName || message.author.username,
    avatar: message.author.displayAvatarURL(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'discord_id' });

  let logged = 0;
  for (let i = 0; i < amounts.length; i++) {
    const { error } = await supabase.from('deals').insert({
      discord_id: message.author.id,
      amount: amounts[i],
      message_id: `${message.id}-${i}`,
      message_url: message.url,
      posted_at: message.createdAt.toISOString(),
    });
    if (!error) logged++;
  }

  if (logged > 0) {
    const total = amounts.reduce((s, n) => s + n, 0);
    console.log(`✅ ${message.author.username}: ${logged} deal(s) — $${total.toLocaleString()}`);
  }
});

discord.login(process.env.DISCORD_TOKEN);
