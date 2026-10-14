
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

const STATUSES = [
  "pending", "confirmed", "processing",
  "shipped", "delivered", "cancelled", "rejected"
];

const PAYMENT_STATUSES = ["pending", "approved", "rejected"];

// Database tables
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      image TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT NOT NULL DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      payment_reference TEXT NOT NULL DEFAULT '',
      feedback TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      store_name TEXT NOT NULL DEFAULT 'Jewellery Store',
      logo_url TEXT NOT NULL DEFAULT '',
      whatsapp TEXT NOT NULL DEFAULT '',
      instagram TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      google_maps TEXT NOT NULL DEFAULT '',
      upi_id TEXT NOT NULL DEFAULT '',
      qr_url TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO store_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
}

function sendError(res, error, status = 500) {
  console.error(error);
  res.status(status).json({
    error: status === 500
      ? "Server error. Render Logs check karein."
      : error
  });
}

function getToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7);
}

function requireAdmin(req, res, next) {
  const token = getToken(req);
  const expires = sessions.get(token);

  if (!token || !expires || expires < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({
      error: "Login dobara karein."
    });
  }

  sessions.set(token, Date.now() + SESSION_TTL);
  next();
}

function validProduct(body) {
  return body &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    body.name.trim().length <= 200 &&
    Number.isFinite(Number(body.price)) &&
    Number(body.price) >= 0 &&
    Number(body.price) <= 100000000 &&
    typeof body.image === "string" &&
    body.image.length <= 2000;
}

function validImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

// Admin login
app.post("/api/admin/login", (req, res) => {
  const password = typeof req.body.password === "string"
    ? req.body.password
    : "";

  const expected = process.env.ADMIN_PASSWORD;

  const a = Buffer.from(password);
  const b = Buffer.from(expected);

  const matches =
    a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) {
    return res.status(401).json({
      error: "Password galat hai."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);

  res.json({ token });
});

// Check login
app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ authenticated: true });
});

// Logout
app.post("/api/admin/logout", (req, res) => {
  sessions.delete(getToken(req));
  res.json({ message: "Logout ho gaya." });
});

// Get store settings (admin only)
app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_settings WHERE id = 1"
    );

    res.json(result.rows[0] || {});
  } catch (error) {
    sendError(res, error);
  }
});

// Save store settings (admin only)
app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const fields = [
      "store_name",
      "logo_url",
      "whatsapp",
      "instagram",
      "phone",
      "email",
      "address",
      "google_maps",
      "upi_id",
      "qr_url"
    ];

    const values = {};

    for (const field of fields) {
      const value = req.body[field];

      if (typeof value !== "string") {
        return res.status(400).json({
          error: "Invalid setting: " + field
        });
      }

      values[field] = value.trim();
    }

    if (!values.store_name || values.store_name.length > 200) {
      return res.status(400).json({
        error: "Store name zaroori hai (maximum 200 characters)."
      });
    }

    for (const field of ["logo_url", "qr_url"]) {
      if (
        values[field] &&
        (!validImageUrl(values[field]) || values[field].length > 2000)
      ) {
        return res.status(400).json({
          error: field + " ke liye valid HTTPS image URL dein."
        });
      }
    }

    if (
      values.instagram &&
      (!validImageUrl(values.instagram) || values.instagram.length > 2000)
    ) {
      return res.status(400).json({
        error: "Instagram ke liye valid HTTPS URL dein."
      });
    }

    if (
      values.google_maps &&
      (!validImageUrl(values.google_maps) || values.google_maps.length > 2000)
    ) {
      return res.status(400).json({
        error: "Google Maps ke liye valid HTTPS URL dein."
      });
    }

    for (const field of fields) {
      if (values[field].length > 2000) {
        return res.status(400).json({
          error: field + " bahut lamba hai."
        });
      }
    }

    const result = await pool.query(
      `UPDATE store_settings SET
        store_name = $1,
        logo_url = $2,
        whatsapp = $3,
        instagram = $4,
        phone = $5,
        email = $6,
        address = $7,
        google_maps = $8,
        upi_id = $9,
        qr_url = $10,
        updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      fields.map(field => values[field])
    );

    res.json({
      message: "Store settings save ho gayi.",
      settings: result.rows[0]
    });
  } catch (error) {
    sendError(res, error);
  }
});

// List products
app.get("/api/products", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

// Add product
app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    if (!validProduct(req.body) || !validImageUrl(req.body.image)) {
      return res.status(400).json({
        error: "Valid name, price aur HTTPS image URL zaroori hai."
      });
    }

    const product = {
      id: crypto.randomUUID(),
      name: req.body.name.trim(),
      price: Number(req.body.price),
      image: req.body.image.trim()
    };

    await pool.query(
      `INSERT INTO products (id, name, price, image)
       VALUES ($1, $2, $3, $4)`,
      [product.id, product.name, product.price, product.image]
    );

    res.status(201).json({
      message: "Product save ho gaya.",
      ...product
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Update product
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    if (!validProduct(req.body) || !validImageUrl(req.body.image)) {
      return res.status(400).json({
        error: "Valid name, price aur HTTPS image URL zaroori hai."
      });
    }

    const result = await pool.query(
      `UPDATE products SET name=$1, price=$2, image=$3
       WHERE id=$4 RETURNING id, name, price, image`,
      [
        req.body.name.trim(),
        Number(req.body.price),
        req.body.image.trim(),
        req.params.id
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product nahi mila."
      });
    }

    res.json({
      message: "Product update ho gaya.",
      ...result.rows[0]
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Delete product
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id=$1",
      [req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product nahi mila."
      });
    }

    res.json({ message: "Product delete ho gaya." });
  } catch (error) {
    sendError(res, error);
  }
});

// List orders
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    sendError(res, error);
  }
});

// Change order status
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const status = req.body.status;

    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        error: "Invalid order status."
      });
    }

    const result = await pool.query(
      `UPDATE orders SET status=$1
       WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Order nahi mila."
      });
    }

    res.json({
      message: "Order status update ho gaya.",
      order: result.rows[0]
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Update payment status
app.patch("/api/orders/:id/payment", requireAdmin, async (req, res) => {
  try {
    const paymentStatus = req.body.payment_status;
    const reference = typeof req.body.payment_reference === "string"
      ? req.body.payment_reference.trim().slice(0, 200)
      : "";

    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({
        error: "Invalid payment status."
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET payment_status=$1, payment_reference=$2
       WHERE id=$3 RETURNING *`,
      [paymentStatus, reference, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Order nahi mila."
      });
    }

    res.json({
      message: "Payment status update ho gaya.",
      order: result.rows[0]
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Serve admin page
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("Jewellery Store server running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
    
