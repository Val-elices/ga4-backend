require("dotenv").config();
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { google } = require("googleapis");
const { BetaAnalyticsDataClient } = require("@google-analytics/data");

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3001/auth/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const SESSION_SECRET = process.env.SESSION_SECRET || "ga4-dashboard-secret-changez-moi";

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.set("trust proxy", 1);
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

function createOAuth2Client() { return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI); }

function getProperties() {
  const envProps = process.env.GA4_PROPERTIES;
  if (envProps) {
    return envProps.split(",").map((entry) => {
      const [name, propertyId] = entry.split(":");
      return { name: name.trim(), propertyId: propertyId.trim() };
    });
  }
  return [
    { name: "E-shop Bordeaux", propertyId: "298374651" },
    { name: "Boutique Lyon", propertyId: "187263549" },
  ];
}

// ════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════

app.get("/auth/login", (req, res) => {
  const oauth2Client = createOAuth2Client();
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: "offline", prompt: "consent",
    scope: ["https://www.googleapis.com/auth/analytics.readonly", "https://www.googleapis.com/auth/userinfo.email"],
  }));
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}?error=no_code`);
  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    req.session.userEmail = userInfo.email;
    console.log(`Utilisateur connecté : ${userInfo.email}`);
    res.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (error) {
    console.error("Erreur OAuth callback:", error.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

app.get("/auth/status", (req, res) => {
  res.json(req.session.tokens ? { authenticated: true, email: req.session.userEmail } : { authenticated: false });
});

app.get("/auth/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });

function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ success: false, error: "Non authentifié." });
  next();
}

function getAuthenticatedClient(tokens) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

function parseDateRange(query) {
  const { days = 30, startDate: qStart, endDate: qEnd } = query;
  const daysNum = parseInt(days);
  let startDate, endDate;
  if (qStart && qEnd) { startDate = qStart; endDate = qEnd; }
  else { startDate = `${daysNum}daysAgo`; endDate = "today"; }
  return { startDate, endDate, daysNum };
}

function formatDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function fmt(d) { return d.toISOString().split("T")[0]; }

function refreshTokens(authClient, session) {
  if (authClient.credentials.access_token !== session.tokens.access_token) {
    session.tokens = authClient.credentials;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════
// REVENUE
// ════════════════════════════════════════════════════════

async function fetchRevenue(authClient, propertyId, startDate, endDate) {
  try {
    const analyticsClient = new BetaAnalyticsDataClient({ authClient });
    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "totalRevenue" }, { name: "transactions" }],
      orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
    });
    return (response.rows || []).map((row) => ({
      date: row.dimensionValues[0].value,
      revenue: parseFloat(row.metricValues[0].value) || 0,
      transactions: parseInt(row.metricValues[1].value) || 0,
    }));
  } catch (error) {
    console.error(`Erreur GA4 revenu ${propertyId}:`, error.message);
    return [];
  }
}

app.get("/api/revenue", requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, daysNum } = parseDateRange(req.query);
    const authClient = getAuthenticatedClient(req.session.tokens);
    const properties = getProperties();

    const results = [];
    for (let i = 0; i < properties.length; i += 5) {
      const batch = properties.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(async (prop) => {
          const data = await fetchRevenue(authClient, prop.propertyId, startDate, endDate);
          return { id: `ga4-${prop.propertyId}`, name: prop.name, propertyId: prop.propertyId, data };
        })
      );
      results.push(...batchResults);
      if (i + 5 < properties.length) await sleep(200);
    }

    const dateMap = {};
    results.forEach((client) => {
      client.data.forEach((row) => {
        const date = formatDate(row.date);
        if (!dateMap[date]) dateMap[date] = { date, total: 0 };
        dateMap[date][client.id] = row.revenue;
        dateMap[date].total += row.revenue;
      });
    });

    const dailyData = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    const clientStats = results.map((client) => {
      const totalRevenue = client.data.reduce((s, r) => s + r.revenue, 0);
      const totalTransactions = client.data.reduce((s, r) => s + r.transactions, 0);
      return {
        id: client.id, name: client.name, propertyId: client.propertyId,
        totalRevenue: Math.round(totalRevenue * 100) / 100, totalTransactions,
        dailyRevenue: client.data.map((r) => r.revenue),
      };
    });

    refreshTokens(authClient, req.session);
    res.json({
      success: true, period: { days: daysNum, startDate, endDate },
      clients: clientStats, dailyData,
      grandTotal: Math.round(clientStats.reduce((s, c) => s + c.totalRevenue, 0) * 100) / 100,
    });
  } catch (error) {
    console.error("Erreur API revenue:", error);
    if (error.code === 401 || error.message?.includes("invalid_grant")) {
      req.session.destroy(); return res.status(401).json({ success: false, error: "Session expirée." });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ════════════════════════════════════════════════════════
// TRAFFIC
// ════════════════════════════════════════════════════════

async function fetchTrafficSessions(authClient, propertyId, startDate, endDate) {
  try {
    const analyticsClient = new BetaAnalyticsDataClient({ authClient });
    const [channelRes] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
    });
    let totalSessions = 0, organicSessions = 0;
    (channelRes.rows || []).forEach((row) => {
      const sessions = parseInt(row.metricValues[0].value) || 0;
      totalSessions += sessions;
      if (row.dimensionValues[0].value.toLowerCase() === "organic search") organicSessions = sessions;
    });
    return { totalSessions, organicSessions };
  } catch (error) {
    console.error(`Erreur GA4 traffic ${propertyId}:`, error.message);
    return { totalSessions: 0, organicSessions: 0 };
  }
}

async function fetchOrganicMonthly(authClient, propertyId) {
  try {
    const analyticsClient = new BetaAnalyticsDataClient({ authClient });
    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: "25monthsAgo", endDate: "today" }],
      dimensions: [{ name: "yearMonth" }, { name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ dimension: { dimensionName: "yearMonth" }, desc: false }],
    });
    const monthlyMap = {};
    (response.rows || []).forEach((row) => {
      const ym = row.dimensionValues[0].value;
      if (row.dimensionValues[1].value.toLowerCase() === "organic search") {
        monthlyMap[ym] = (monthlyMap[ym] || 0) + (parseInt(row.metricValues[0].value) || 0);
      }
    });
    return Object.entries(monthlyMap).map(([yearMonth, sessions]) => ({ yearMonth, sessions })).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  } catch (error) {
    console.error(`Erreur GA4 organic monthly ${propertyId}:`, error.message);
    return [];
  }
}

app.get("/api/traffic", requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const authClient = getAuthenticatedClient(req.session.tokens);
    const properties = getProperties();

    const now = new Date();
    let currentStart, currentEnd;
    if (req.query.startDate && req.query.endDate) {
      currentStart = new Date(req.query.startDate); currentEnd = new Date(req.query.endDate);
    } else {
      currentEnd = now; currentStart = new Date(now);
      currentStart.setDate(currentStart.getDate() - (parseInt(req.query.days) || 30));
    }
    const diffDays = Math.ceil((currentEnd - currentStart) / (1000 * 60 * 60 * 24));

    const prevMonthEnd = new Date(currentStart); prevMonthEnd.setDate(prevMonthEnd.getDate() - 1);
    const prevMonthStart = new Date(prevMonthEnd); prevMonthStart.setDate(prevMonthStart.getDate() - diffDays);
    const prevYearStart = new Date(currentStart); prevYearStart.setFullYear(prevYearStart.getFullYear() - 1);
    const prevYearEnd = new Date(currentEnd); prevYearEnd.setFullYear(prevYearEnd.getFullYear() - 1);

    const results = [];
    for (let i = 0; i < properties.length; i += 3) {
      const batch = properties.slice(i, i + 3);
      console.log(`Traffic batch ${Math.floor(i / 3) + 1}/${Math.ceil(properties.length / 3)}`);
      const batchResults = await Promise.all(
        batch.map(async (prop) => {
          const [current, prevMonth, prevYear, monthlyOrganic] = await Promise.all([
            fetchTrafficSessions(authClient, prop.propertyId, startDate, endDate),
            fetchTrafficSessions(authClient, prop.propertyId, fmt(prevMonthStart), fmt(prevMonthEnd)),
            fetchTrafficSessions(authClient, prop.propertyId, fmt(prevYearStart), fmt(prevYearEnd)),
            fetchOrganicMonthly(authClient, prop.propertyId),
          ]);
          const organicVsM1 = prevMonth.organicSessions > 0 ? ((current.organicSessions - prevMonth.organicSessions) / prevMonth.organicSessions) * 100 : 0;
          const organicVsN1 = prevYear.organicSessions > 0 ? ((current.organicSessions - prevYear.organicSessions) / prevYear.organicSessions) * 100 : 0;
          return {
            id: `ga4-${prop.propertyId}`, name: prop.name, propertyId: prop.propertyId,
            totalSessions: current.totalSessions, organicSessions: current.organicSessions,
            organicVsM1: Math.round(organicVsM1 * 10) / 10, organicVsN1: Math.round(organicVsN1 * 10) / 10,
            prevMonthOrganic: prevMonth.organicSessions, prevYearOrganic: prevYear.organicSessions,
            monthlyOrganic,
          };
        })
      );
      results.push(...batchResults);
      if (i + 3 < properties.length) await sleep(500);
    }

    const validM1 = results.filter((r) => r.prevMonthOrganic > 0);
    const validN1 = results.filter((r) => r.prevYearOrganic > 0);
    const avgM1 = validM1.length > 0 ? Math.round((validM1.reduce((s, r) => s + r.organicVsM1, 0) / validM1.length) * 10) / 10 : 0;
    const avgN1 = validN1.length > 0 ? Math.round((validN1.reduce((s, r) => s + r.organicVsN1, 0) / validN1.length) * 10) / 10 : 0;

    refreshTokens(authClient, req.session);
    res.json({
      success: true, clients: results,
      summary: {
        totalSessions: results.reduce((s, r) => s + r.totalSessions, 0),
        totalOrganic: results.reduce((s, r) => s + r.organicSessions, 0),
        avgOrganicVsM1: avgM1, avgOrganicVsN1: avgN1,
        clientCount: results.length,
      },
    });
  } catch (error) {
    console.error("Erreur API traffic:", error);
    if (error.code === 401 || error.message?.includes("invalid_grant")) {
      req.session.destroy(); return res.status(401).json({ success: false, error: "Session expirée." });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ════════════════════════════════════════════════════════
// GROWTH FROM FIXED REFERENCE DATE
// Compare: reference month organic sessions vs current month
// Then show month-by-month evolution from reference date
// ════════════════════════════════════════════════════════

app.get("/api/growth", requireAuth, async (req, res) => {
  try {
    const { refDate } = req.query; // format: YYYY-MM-DD
    if (!refDate) return res.status(400).json({ success: false, error: "refDate requis (ex: 2024-01-01)" });

    const authClient = getAuthenticatedClient(req.session.tokens);
    const properties = getProperties();

    // We fetch monthly organic data from refDate to today for all clients
    // Then aggregate by month across all clients
    console.log(`Growth: fetching from ${refDate} to today for ${properties.length} properties`);

    const allMonthlyData = [];
    for (let i = 0; i < properties.length; i += 3) {
      const batch = properties.slice(i, i + 3);
      console.log(`Growth batch ${Math.floor(i / 3) + 1}/${Math.ceil(properties.length / 3)}`);

      const batchResults = await Promise.all(
        batch.map(async (prop) => {
          try {
            const analyticsClient = new BetaAnalyticsDataClient({ authClient });
            const [response] = await analyticsClient.runReport({
              property: `properties/${prop.propertyId}`,
              dateRanges: [{ startDate: refDate, endDate: "today" }],
              dimensions: [{ name: "yearMonth" }, { name: "sessionDefaultChannelGroup" }],
              metrics: [{ name: "sessions" }],
              orderBys: [{ dimension: { dimensionName: "yearMonth" }, desc: false }],
            });

            const monthly = {};
            (response.rows || []).forEach((row) => {
              const ym = row.dimensionValues[0].value;
              if (row.dimensionValues[1].value.toLowerCase() === "organic search") {
                monthly[ym] = (monthly[ym] || 0) + (parseInt(row.metricValues[0].value) || 0);
              }
            });
            return monthly;
          } catch (err) {
            console.error(`Growth error for ${prop.propertyId}:`, err.message);
            return {};
          }
        })
      );
      allMonthlyData.push(...batchResults);
      if (i + 3 < properties.length) await sleep(500);
    }

    // Aggregate: sum all clients per month
    const aggregated = {};
    allMonthlyData.forEach((clientMonthly) => {
      Object.entries(clientMonthly).forEach(([ym, sessions]) => {
        aggregated[ym] = (aggregated[ym] || 0) + sessions;
      });
    });

    // Sort by yearMonth
    const months = Object.entries(aggregated)
      .map(([yearMonth, sessions]) => ({ yearMonth, sessions }))
      .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

    if (months.length === 0) {
      refreshTokens(authClient, req.session);
      return res.json({ success: true, months: [], referenceDate: refDate, referenceSessions: 0, growth: [] });
    }

    // Reference = first month
    const refSessions = months[0].sessions;

    // Calculate growth for each month vs reference
    const growth = months.map((m) => ({
      yearMonth: m.yearMonth,
      sessions: m.sessions,
      growthVsRef: refSessions > 0 ? Math.round(((m.sessions - refSessions) / refSessions) * 1000) / 10 : 0,
    }));

    refreshTokens(authClient, req.session);

    res.json({
      success: true,
      referenceDate: refDate,
      referenceMonth: months[0].yearMonth,
      referenceSessions: refSessions,
      currentMonth: months[months.length - 1].yearMonth,
      currentSessions: months[months.length - 1].sessions,
      totalGrowth: refSessions > 0
        ? Math.round(((months[months.length - 1].sessions - refSessions) / refSessions) * 1000) / 10
        : 0,
      months: growth,
      clientCount: properties.length,
    });
  } catch (error) {
    console.error("Erreur API growth:", error);
    if (error.code === 401 || error.message?.includes("invalid_grant")) {
      req.session.destroy(); return res.status(401).json({ success: false, error: "Session expirée." });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ════════════════════════════════════════════════════════
// HEALTH & PROPERTIES
// ════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", properties: getProperties().length, authenticated: !!req.session?.tokens, timestamp: new Date().toISOString() });
});

app.get("/api/properties", (req, res) => {
  res.json({ success: true, properties: getProperties() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GA4 API server (OAuth2) running on port ${PORT}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Properties configured: ${getProperties().length}`);
});
