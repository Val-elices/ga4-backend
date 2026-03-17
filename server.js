require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const { google } = require("googleapis");
const { BetaAnalyticsDataClient } = require("@google-analytics/data");

const app = express();
app.use(express.json());

// ─── Configuration ───
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3001/auth/callback";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const SESSION_SECRET = process.env.SESSION_SECRET || "ga4-dashboard-secret-changez-moi";

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.set("trust proxy", 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

// ─── OAuth2 Client ───
function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

// ─── Propriétés GA4 ───
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
    { name: "Store Paris", propertyId: "394817265" },
  ];
}

// ════════════════════════════════════════════════════════
// ROUTES AUTH
// ════════════════════════════════════════════════════════

// 1. Démarrer la connexion Google
app.get("/auth/login", (req, res) => {
  const oauth2Client = createOAuth2Client();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // Pour obtenir un refresh_token
    prompt: "consent",      // Forcer le consentement pour toujours avoir le refresh_token
    scope: [
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
  res.redirect(authUrl);
});

// 2. Callback après connexion Google
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${FRONTEND_URL}?error=no_code`);
  }

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    // Stocker les tokens en session
    req.session.tokens = tokens;

    // Récupérer l'email de l'utilisateur
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    req.session.userEmail = userInfo.email;

    console.log(`Utilisateur connecté : ${userInfo.email}`);

    // Rediriger vers le frontend
    res.redirect(`${FRONTEND_URL}?auth=success`);
  } catch (error) {
    console.error("Erreur OAuth callback:", error.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// 3. Vérifier si connecté
app.get("/auth/status", (req, res) => {
  if (req.session.tokens) {
    res.json({
      authenticated: true,
      email: req.session.userEmail,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// 4. Déconnexion
app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
// MIDDLEWARE AUTH
// ════════════════════════════════════════════════════════

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({
      success: false,
      error: "Non authentifié. Connectez-vous via /auth/login",
    });
  }
  next();
}

function getAuthenticatedClient(tokens) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// ════════════════════════════════════════════════════════
// ROUTES API
// ════════════════════════════════════════════════════════

// Récupérer le revenu d'une propriété avec les tokens OAuth2 de l'utilisateur
async function fetchRevenue(authClient, propertyId, startDate, endDate) {
  try {
    const analyticsClient = new BetaAnalyticsDataClient({
      authClient: authClient,
    });

    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "totalRevenue" },
        { name: "transactions" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
    });

    const rows = (response.rows || []).map((row) => ({
      date: row.dimensionValues[0].value,
      revenue: parseFloat(row.metricValues[0].value) || 0,
      transactions: parseInt(row.metricValues[1].value) || 0,
    }));

    return rows;
  } catch (error) {
    console.error(`Erreur GA4 propriété ${propertyId}:`, error.message);
    return [];
  }
}

function formatDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// Route principale : revenus agrégés
app.get("/api/revenue", requireAuth, async (req, res) => {
  try {
	const { days = 30, startDate: qStart, endDate: qEnd } = req.query;
	let startDate, endDate;
	if (qStart && qEnd) {
	  startDate = qStart;
	  endDate = qEnd;
	} else {
	  const daysNum = parseInt(days);
	  startDate = `${daysNum}daysAgo`;
	  endDate = "today";
	}

    const authClient = getAuthenticatedClient(req.session.tokens);
    const properties = getProperties();

    const results = await Promise.all(
      properties.map(async (prop) => {
        const data = await fetchRevenue(authClient, prop.propertyId, startDate, endDate);
        return {
          id: `ga4-${prop.propertyId}`,
          name: prop.name,
          propertyId: prop.propertyId,
          data,
        };
      })
    );

    const dateMap = {};
    results.forEach((client) => {
      client.data.forEach((row) => {
        const date = formatDate(row.date);
        if (!dateMap[date]) {
          dateMap[date] = { date, total: 0 };
        }
        dateMap[date][client.id] = row.revenue;
        dateMap[date][`${client.id}_transactions`] = row.transactions;
        dateMap[date].total += row.revenue;
      });
    });

    const dailyData = Object.values(dateMap).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const clientStats = results.map((client) => {
      const totalRevenue = client.data.reduce((s, r) => s + r.revenue, 0);
      const totalTransactions = client.data.reduce((s, r) => s + r.transactions, 0);
      return {
        id: client.id,
        name: client.name,
        propertyId: client.propertyId,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalTransactions,
        dailyRevenue: client.data.map((r) => r.revenue),
      };
    });

    const grandTotal = clientStats.reduce((s, c) => s + c.totalRevenue, 0);

    // Mettre à jour les tokens si refresh
    if (authClient.credentials.access_token !== req.session.tokens.access_token) {
      req.session.tokens = authClient.credentials;
    }

    res.json({
      success: true,
      period: { days: daysNum, startDate, endDate },
      clients: clientStats,
      dailyData,
      grandTotal: Math.round(grandTotal * 100) / 100,
    });
  } catch (error) {
    console.error("Erreur API:", error);

    if (error.code === 401 || error.message?.includes("invalid_grant")) {
      req.session.destroy();
      return res.status(401).json({
        success: false,
        error: "Session expirée. Reconnectez-vous.",
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Santé
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    properties: getProperties().length,
    authenticated: !!req.session?.tokens,
    timestamp: new Date().toISOString(),
  });
});

// Liste des propriétés
app.get("/api/properties", (req, res) => {
  res.json({ success: true, properties: getProperties() });
});

// ─── Démarrage ───
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GA4 API server (OAuth2) running on port ${PORT}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log(`Properties configured: ${getProperties().length}`);
});
