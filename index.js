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

const DEAL_CHANNEL_ID       = process.env.DEAL_CHANNEL_ID;
const DAILY_LB_CHANNEL_ID   = process.env.DAILY_LB_CHANNEL_ID;
const WEEKLY_LB_CHANNEL_ID  = process.env.WEEKLY_LB_CHANNEL_ID;
const MONTHLY_LB_CHANNEL_ID = process.env.MONTHLY_LB_CHANNEL_ID;

let lbMessageIds = { daily: null, weekly: null, monthly: null };

// ============================================================
// DEAL SIGNALS
// ============================================================
const DEAL_SIGNALS = [
  'americo','ethos','aetna','transamerica','chubb','lincoln',
  'mutual of omaha','foresters','sbli','corebridge','kemper',
  'gerber','nationwide','prudential','john hancock','pacific life',
  'paclife','aig','royal neighbors','security benefit','five star',
  'amam','siwl','giwl','sgiwl','gsiwl','freakos','freakohoes',
  'frankos','moo ','moo\n','moo$','moo!',
  'iul','rtd','lp ','lp\n',' ap ','ap ',
  'term ','whole life','max fund','select ',
  'uw','uwed','immediate','imm ','approved',
  'submitted','issued','placed','inforce',
  'graded','preferred','bob ','ta ',
  'trans ','trans\n','tranz','trans$','trans🏳',
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

function parseAllAmounts(content) {
  const found = new Set();
  const reBefore = /[\$#]\s*([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = reBefore.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }
  const reAfter = /([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*\$/g;
  while ((m = reAfter.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }
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
  if (Number.isInteger(n) && n >= 2020 && n <= 2030) return false;
  return true;
}

// ============================================================
// DATE HELPERS — week starts Sunday
// ============================================================
function getDateRange(period) {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return {
      start,
      label: `📅 ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`
    };
  }
  if (period === 'weekly') {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay()); // Sunday = day 0
    start.setHours(0, 0, 0, 0);
    return {
      start,
      label: `📅 Week of ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    };
  }
  if (period === 'monthly') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      start,
      label: `📅 ${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`
    };
  }
}

// ============================================================
// BUILD LEADERBOARD MESSAGE
// ============================================================
async function buildLeaderboard(period) {
  const { start, label } = getDateRange(period);

  const { data: deals, error } = await supabase
    .from('deals')
    .select('discord_id, amount')
    .gte('posted_at', start.toISOString());

  if (error || !deals) return null;

  const map = {};
  deals.forEach(d => {
    if (!map[d.discord_id]) map[d.discord_id] = { total: 0, count: 0 };
    map[d.discord_id].total += parseFloat(d.amount);
    map[d.discord_id].count++;
  });

  const titles = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };

  if (Object.keys(map).length === 0) {
    return `🏆 **${titles[period]} LEADERBOARD** — Blueprint × Foundation\n${label}\n\n*No deals posted yet. Get after it!*`;
  }

  const ids = Object.keys(map);
  const { data: users } = await supabase
    .from('users')
    .select('discord_id, display_name')
    .in('discord_id', ids);

  const userMap = {};
  (users || []).forEach(u => userMap[u.discord_id] = u.display_name);

  const sorted = Object.entries(map)
    .map(([id, stats]) => ({ id, ...stats, name: userMap[id] || 'Unknown' }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);

  const totalProduction = sorted.reduce((s, u) => s + u.total, 0);
  const totalDeals = sorted.reduce((s, u) => s + u.count, 0);
  const medals = ['🥇', '🥈', '🥉'];

  let msg = `🏆 **${titles[period]} LEADERBOARD** — Blueprint × Foundation\n`;
  msg += `${label}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  sorted.forEach((u, i) => {
    const medal = medals[i] || `**${i + 1}.**`;
    const name = u.name.length > 20 ? u.name.slice(0, 20) + '…' : u.name;
    const total = `$${Math.round(u.total).toLocaleString()}`;
    const deals = `(${u.count} deal${u.count !== 1 ? 's' : ''})`;
    msg += `${medal} ${name.padEnd(22)} ${total.padStart(9)}  ${deals}\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 **Agency Total:** $${Math.round(totalProduction).toLocaleString()}  |  **Deals:** ${totalDeals}\n`;
  msg += `⏱ *Updated: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}*`;

  return msg;
}

// ============================================================
// POST OR EDIT LEADERBOARD
// ============================================================
async function updateLeaderboard(period) {
  const channelIds = {
    daily:   DAILY_LB_CHANNEL_ID,
    weekly:  WEEKLY_LB_CHANNEL_ID,
    monthly: MONTHLY_LB_CHANNEL_ID,
  };
  const channelId = channelIds[period];
  if (!channelId) return;

  try {
    const channel = await discord.channels.fetch(channelId);
    const content = await buildLeaderboard(period);
    if (!content) return;

    if (lbMessageIds[period]) {
      try {
        const msg = await channel.messages.fetch(lbMessageIds[period]);
        await msg.edit(content);
        return;
      } catch(e) {
        lbMessageIds[period] = null;
      }
    }

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(m => m.author.id === discord.user.id);
    if (existing) {
      await existing.edit(content);
      lbMessageIds[period] = existing.id;
    } else {
      const sent = await channel.send(content);
      lbMessageIds[period] = sent.id;
      try { await sent.pin(); } catch(e) {}
    }
  } catch(e) {
    console.error(`Leaderboard error (${period}):`, e.message);
  }
}

async function updateAllLeaderboards() {
  await updateLeaderboard('daily');
  await updateLeaderboard('weekly');
  await updateLeaderboard('monthly');
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
// BACKFILL
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
  await updateAllLeaderboards();
}

// ============================================================
// MIDNIGHT RESET
// ============================================================
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const ms = midnight - now;

  setTimeout(async () => {
    console.log('🌙 Midnight reset');
    await updateAllLeaderboards();
    scheduleMidnightReset();
  }, ms);
}

// ============================================================
// BOT EVENTS
// ============================================================
discord.on('ready', async () => {
  console.log(`✅ Bot online as ${discord.user.tag}`);
  await updateAllLeaderboards();
  const channel = await discord.channels.fetch(DEAL_CHANNEL_ID);
  await backfill(channel);
  scheduleMidnightReset();
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DEAL_CHANNEL_ID) return;
  const amounts = parseAllAmounts(message.content);
  if (!looksLikeADeal(message.content, amounts)) return;
  await upsertUser(message);
  const logged = await logDeals(message, amounts);
  if (logged > 0) {
    const total = amounts.reduce((s, n) => s + n, 0);
    console.log(`✅ ${message.author.username}: ${logged} deal(s) — $${total.toLocaleString()}`);
    await updateAllLeaderboards();
  }
});

discord.login(process.env.DISCORD_TOKEN);
