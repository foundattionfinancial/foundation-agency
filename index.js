const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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
let lbOffsets    = { daily: 0,    weekly: 0,    monthly: 0 };

// ============================================================
// DEAL SIGNALS
// ============================================================
const DEAL_SIGNALS = [
  'americo','ethos','aetna','transamerica','chubb','lincoln',
  'mutual of omaha','foresters','sbli','corebridge','kemper',
  'gerber','nationwide','prudential','john hancock','pacific life',
  'paclife','aig','royal neighbors','security benefit','five star',
  'amam','siwl','giwl','sgiwl','gsiwl','freakos','freakohoes',
  'frankos','moo','iul','rtd','lp','ap','term','whole life',
  'max fund','select','uw','uwed','immediate','imm','approved',
  'submitted','issued','placed','inforce','graded','preferred',
  'bob','ta','trans','tranz',
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
  // $ sign alone is enough — no carrier needed
  if (hasDollarSign(content)) return true;
  return hasDealSignal(content);
}

function parseAllAmounts(content) {
  const found = new Set();

  // Pass 1: $ or # before number
  const reBefore = /[\$#]\s*([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = reBefore.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // Pass 2: number followed by $
  const reAfter = /([\d]{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*\$/g;
  while ((m = reAfter.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // Pass 3: no $ but has carrier — grab standalone numbers
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
// DATE RANGE — all times in UTC-based but use local day boundaries
// ============================================================
function getDateRange(period, offset = 0) {
  const now = new Date();

  if (period === 'daily') {
    // Start = midnight of (today + offset)
    const start = new Date(now);
    start.setDate(start.getDate() + offset);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    const isLive = offset === 0;
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const label = isLive ? `Today — ${dateStr}` : dateStr;
    return { start, end, label, isLive };
  }

  if (period === 'weekly') {
    const ref = new Date(now);
    ref.setDate(ref.getDate() + offset * 7);
    // Go back to Sunday
    const start = new Date(ref);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const isLive = offset === 0;
    const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return { start, end, label: `Week of ${startStr} – ${endStr}`, isLive };
  }

  if (period === 'monthly') {
    const ref = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);

    const isLive = offset === 0;
    const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return { start, end, label, isLive };
  }
}

// ============================================================
// CHECK IF PREVIOUS PERIOD HAS ANY DATA
// ============================================================
async function hasPreviousData(period, offset) {
  const { start, end } = getDateRange(period, offset - 1);
  const { count } = await supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .gte('posted_at', start.toISOString())
    .lte('posted_at', end.toISOString());
  return count > 0;
}

// ============================================================
// BUILD LEADERBOARD
// ============================================================
async function buildLeaderboard(period, offset = 0) {
  const { start, end, label, isLive } = getDateRange(period, offset);

  const { data: deals, error } = await supabase
    .from('deals')
    .select('discord_id, amount')
    .gte('posted_at', start.toISOString())
    .lte('posted_at', end.toISOString());

  if (error || !deals) return null;

  const map = {};
  deals.forEach(d => {
    if (!map[d.discord_id]) map[d.discord_id] = { total: 0, count: 0 };
    map[d.discord_id].total += parseFloat(d.amount);
    map[d.discord_id].count++;
  });

  const periodTitle = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  const liveTag = isLive ? ' 🟢' : '';

  if (Object.keys(map).length === 0) {
    return [
      `🏆 __**Blueprint Top Producers**__ | ${periodTitle[period]}${liveTag}`,
      `📅 ${label}`,
      ``,
      `*No deals posted yet — let's get it!* 💪`
    ].join('\n');
  }

  const ids = Object.keys(map);
  const { data: users } = await supabase
    .from('users')
    .select('discord_id, display_name')
    .in('discord_id', ids);

  const userMap = {};
  (users || []).forEach(u => userMap[u.discord_id] = u.display_name);

  const sorted = Object.entries(map)
    .map(([id, stats]) => ({
      id, ...stats,
      name: userMap[id] || 'Unknown'
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);

  const agencyTotal = sorted.reduce((s, u) => s + u.total, 0);
  const agencyDeals = sorted.reduce((s, u) => s + u.count, 0);

  const rankIcon = (i) => ['🥇','🥈','🥉'][i] || `${i + 1}.`;

  let lines = [];
  lines.push(`🏆 __**Blueprint Top Producers**__ | ${periodTitle[period]}${liveTag}`);
  lines.push(`📅 ${label}`);
  lines.push(`**▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬**`);

  sorted.forEach((u, i) => {
    const name = u.name.length > 22 ? u.name.slice(0, 21) + '…' : u.name;
    const total = `$${Math.round(u.total).toLocaleString()}`;
    const deals = `${u.count} deal${u.count !== 1 ? 's' : ''}`;
    lines.push(`${rankIcon(i)} **${name}** — ${total} | ${deals}`);
  });

  lines.push(`**▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬**`);
  lines.push(`💰 **Total: $${Math.round(agencyTotal).toLocaleString()}** | ${agencyDeals} deals`);
  if (isLive) {
    lines.push(`*Updated ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}*`);
  }

  return lines.join('\n');
}

// ============================================================
// BUILD BUTTONS — prev disabled if no data, next disabled if live
// ============================================================
async function buildButtons(period, offset) {
  const isLive = offset === 0;
  const prevHasData = await hasPreviousData(period, offset);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb_prev_${period}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!prevHasData),
    new ButtonBuilder()
      .setCustomId(`lb_next_${period}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLive),
  );
  return row;
}

// ============================================================
// POST OR EDIT LEADERBOARD
// ============================================================
async function updateLeaderboard(period, offset = null) {
  const channelIds = {
    daily:   DAILY_LB_CHANNEL_ID,
    weekly:  WEEKLY_LB_CHANNEL_ID,
    monthly: MONTHLY_LB_CHANNEL_ID,
  };
  const channelId = channelIds[period];
  if (!channelId) return;

  if (offset === null) offset = lbOffsets[period];

  try {
    const channel = await discord.channels.fetch(channelId);
    const content = await buildLeaderboard(period, offset);
    if (!content) return;

    const components = [await buildButtons(period, offset)];
    const payload = { content, components };

    // Try to edit existing message
    if (lbMessageIds[period]) {
      try {
        const msg = await channel.messages.fetch(lbMessageIds[period]);
        await msg.edit(payload);
        return;
      } catch(e) {
        lbMessageIds[period] = null;
      }
    }

    // Search for existing bot message
    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find(m => m.author.id === discord.user.id && m.components?.length > 0);
    if (existing) {
      await existing.edit(payload);
      lbMessageIds[period] = existing.id;
      return;
    }

    // Post new
    const sent = await channel.send(payload);
    lbMessageIds[period] = sent.id;
    try { await sent.pin(); } catch(e) {}
  } catch(e) {
    console.error(`LB error (${period}):`, e.message);
  }
}

async function updateAllLeaderboards() {
  await Promise.all([
    updateLeaderboard('daily'),
    updateLeaderboard('weekly'),
    updateLeaderboard('monthly'),
  ]);
}

// ============================================================
// BUTTON INTERACTIONS
// ============================================================
discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith('lb_')) return;

  const parts = customId.split('_');
  const action = parts[1];
  const period = parts[2];

  if (action === 'prev') lbOffsets[period] -= 1;
  if (action === 'next' && lbOffsets[period] < 0) lbOffsets[period] += 1;

  await interaction.deferUpdate();
  await updateLeaderboard(period, lbOffsets[period]);
});

// ============================================================
// DB HELPERS
// ============================================================
async function upsertUser(message) {
  try {
    await supabase.from('users').upsert({
      discord_id: message.author.id,
      username: message.author.username,
      display_name: message.member?.displayName || message.author.username,
      avatar: message.author.displayAvatarURL(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'discord_id' });
  } catch(e) { console.error('upsertUser:', e.message); }
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
    lbOffsets = { daily: 0, weekly: 0, monthly: 0 };
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
    // Update only live leaderboards
    const updates = [];
    if (lbOffsets.daily === 0)   updates.push(updateLeaderboard('daily'));
    if (lbOffsets.weekly === 0)  updates.push(updateLeaderboard('weekly'));
    if (lbOffsets.monthly === 0) updates.push(updateLeaderboard('monthly'));
    await Promise.all(updates);
  }
});

discord.login(process.env.DISCORD_TOKEN);
