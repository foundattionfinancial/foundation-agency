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

// ============================================================
// EVERY signal that means "this is a deal post"
// Rule: message must have $ sign OR one of these keywords/emojis
// ============================================================
const DEAL_SIGNALS = [
  // Major carriers
  'americo','ethos','aetna','transamerica','chubb','lincoln',
  'mutual of omaha','foresters','sbli','corebridge','kemper',
  'gerber','nationwide','prudential','john hancock','pacific life',
  'paclife','aig','royal neighbors','security benefit','five star',
  // FFL product codes
  'amam','siwl','giwl','sgiwl','gsiwl','freakos','freakohoes',
  'frankos','moo ','moo\n','moo$','moo!',
  // Product types
  'iul','rtd','lp ','lp\n',' ap ','ap ',
  'term ','whole life','max fund','select ',
  // Status words that only appear in deal posts
  'uw','uwed','immediate','imm ','approved',
  'submitted','issued','placed','inforce',
  'graded','preferred','bob ','ta ',
  // Carrier shorthand
  'trans ','trans\n','tranz','trans$','trans🏳',
  // Emojis used as carrier signals
  '🐮','🦅','💜','💚','🏳️‍⚧️','🦠','🐣','🐥',
];

function hasDollarSign(content) {
  return /[\$#]\s*\d/.test(content) || /\d\s*\$/.test(content);
}

function hasDealSignal(content) {
  const lower = content.toLowerCase();
  return DEAL_SIGNALS.some(s => lower.includes(s));
}

function looksLikeADeal(content, amounts) {
  if (amounts.length === 0) return false;
  return hasDollarSign(content) || hasDealSignal(content);
}

// ============================================================
// PARSE ALL AMOUNTS
// Handles every format seen in the channel:
// $1,234.56 | $ 324 | 1234$ | 1,234$ | #1318.68
// 1200 ethos | AP 4799.28 GIWL | 420 🦅 #1
// ============================================================
function parseAllAmounts(content) {
  const found = new Set();

  // Pass 1: numbers preceded by $ or # (with optional space)
  const reBefore = /[\$#]\s*([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = reBefore.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // Pass 2: numbers followed by $
  const reAfter = /([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*\$/g;
  while ((m = reAfter.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // Pass 3: if has deal signal but no $ found yet, grab all standalone numbers
  if (found.size === 0 && hasDealSignal(content)) {
    const reStandalone = /(?<![.\d])([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d{3,}(?:\.\d{1,2})?)(?![.\d])/g;
    while ((m = reStandalone.exec(content)) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (valid(n)) found.add(n);
    }
  }

  return [...found];
}

function valid(n) {
  if (isNaN(n) || n < 100 || n > 50000) return false;
  // Exclude years
  if (Number.isInteger(n) && n >= 2020 && n <= 2030) return false;
  return true;
}

// ============================================================
// DB HELPERS
// ============================================================
async function upsertUser(message) {
  await supabase.from('users').upsert({
    discord_id: message.author.id,
    username: message.author.username,
    display_name: message.member?.displayName || message.author.username,
    avatar: message.author.displayAvatarURL(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'discord_id' });
}

async function logDeals(message, amounts) {
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
  return logged;
}

// ============================================================
// BACKFILL — reads all history
// ============================================================
async function backfill(channel) {
  console.log('🔄 Starting backfill...');
  let before = null;
  let totalDeals = 0;
  let msgCount = 0;

  while (true) {
    const opts = { limit: 100 };
    if (before) opts.before = before;
    let messages;
    try { messages = await channel.messages.fetch(opts); }
    catch(e) { console.error('fetch error:', e.message); break; }
    if (messages.size === 0) break;

    for (const msg of messages.values()) {
      if (msg.author.bot) continue;
      const amounts = parseAllAmounts(msg.content);
      if (!looksLikeADeal(msg.content, amounts)) continue;
      await upsertUser(msg);
      totalDeals += await logDeals(msg, amounts);
      msgCount++;
    }

    console.log(`📦 ${msgCount} deal msgs → ${totalDeals} deals logged...`);
    before = messages.last().id;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`✅ Backfill complete! ${totalDeals} deals from ${msgCount} messages.`);
}

// ============================================================
// BOT
// ============================================================
discord.on('ready', async () => {
  console.log(`✅ Bot online as ${discord.user.tag}`);
  const channel = await discord.channels.fetch(process.env.DEAL_CHANNEL_ID);
  await backfill(channel);
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== process.env.DEAL_CHANNEL_ID) return;
  const amounts = parseAllAmounts(message.content);
  if (!looksLikeADeal(message.content, amounts)) return;
  await upsertUser(message);
  const logged = await logDeals(message, amounts);
  if (logged > 0) {
    console.log(`✅ ${message.author.username}: ${logged} deal(s) — $${amounts.reduce((s,n)=>s+n,0).toLocaleString()}`);
  }
});

discord.login(process.env.DISCORD_TOKEN);
