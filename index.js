// ============================================================
// THE FOUNDATION — Discord Deal Bot (Real Format Handler)
// Handles all the messy real-world posting formats seen in #daily-sales
// ============================================================

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
    if (!isNaN(num) && num >= 100 && num <= 50000 && !(num >= 2020 && num <= 2030)) {
      amounts.push(num);
    }
  }
  return amounts;
}

function looksLikeADeal(content, amounts) {
  if (amounts.length === 0) return false;
  if (content.includes('$')) return true;
  const lower = content.toLowerCase();
  const carriers = [
    'americo','ethos','moo','trans','tranz','aetna','amam',
    'siwl','giwl','freakos','chubb','iul','rtd','select',
    'freakohoes','frankos','lincoln','mutual'
  ];
  return carriers.some(c => lower.includes(c));
}

discord.on('ready', () => {
  console.log(`✅ Foundation Bot online as ${discord.user.tag}`);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== process.env.DEAL_CHANNEL_ID) return;

  const amounts = parseAllAmounts(message.content);
  if (!looksLikeADeal(message.content, amounts)) return;

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
    await message.react('📊').catch(() => {});
    const total = amounts.reduce((s, n) => s + n, 0);
    console.log(`✅ ${message.author.username}: ${logged} deal(s) — $${total.toLocaleString()}`);
  }
});

discord.login(process.env.DISCORD_TOKEN);
