"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Main website pages
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.use(express.static(path.join(__dirname, "public")));

// PostgreSQL
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

pool.on("error", (err) => {
  console.error("Database error:", err.message);
});

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

// In-memory login tokens: they expire after 8 hours.
// Render restart will invalidate existing tokens.
const adminTokens = new Map();
const TOKEN_LIFETIME = 8 * 60 * 60 * 1000;

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

function requireAdmin(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Admin login required"
    });
  }

  const expiry = adminTokens.get(token);

  if (!expiry || expiry < Date.now()) {
    adminTokens.delete(token);
    return res.status(401).json({
      success: false,
      message: "Session expired. Please log in again."
    });
  }

  next();
}

// Login endpoint
app.post("/api/admin/login", (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = String(req.body?.password || "");

  if (!configuredPassword) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_PASSWORD is not configured in Render"
    });
  }

  const expected = Buffer.from(configuredPassword);
  const actual = Buffer.from(suppliedPassword);

  const passwordMatches =
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);

  if (!passwordMatches) {
    return res.status(401).json({
      success: false,
      message: "Incorrect admin password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.set(token, Date.now() + TOKEN_LIFETIME);

  res.json({
    success: true,
    token,
    message: "Login successful"
  });
});

// Check whether a session is valid
app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, authenticated: true });
});

// Logout
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = getBearerToken(req);
  adminTokens.delete(token);
  res.json({ success: true, message: "Logged out" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "Server is running" });
});
// Create database tables
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'COD',
      payment_status TEXT NOT NULL DEFAULT 'PENDING',
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
}

// Public product list
app.get("/api/products", async (req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY id DESC"
    );

    res.json({ success: true, products: result.rows });
  } catch (err) {
    console.error("Products error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load products"
    });
  }
});

// Admin: list orders
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(
      "SELECT * FROM orders ORDER BY id DESC LIMIT 500"
    );

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    console.error("Orders error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load orders"
    });
  }
});

// Admin: create a product
app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const name = String(req.body?.name || "").trim();
    const price = Number(req.body?.price);
    const image = String(req.body?.image || "").trim();

    if (!name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid product name and price are required"
      });
    }

    const result = await pool.query(
      `INSERT INTO products (name, price, image)
       VALUES ($1, $2, $3)
       RETURNING id, name, price, image`,
      [name, price, image]
    );

    res.status(201).json({
      success: true,
      product: result.rows[0]
    });
  } catch (err) {
    console.error("Create product error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not create product"
    });
  }
});

// Admin: update a product
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const id = Number(req.params.id);
    const name = String(req.body?.name || "").trim();
    const price = Number(req.body?.price);
    const image = String(req.body?.image || "").trim();

    if (!Number.isSafeInteger(id) || id < 1 ||
        !name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid product details"
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET name = $1, price = $2, image = $3
       WHERE id = $4
       RETURNING id, name, price, image`,
      [name, price, image, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error("Update product error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not update product"
    });
  }
});

// Admin: delete a product
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID"
      });
    }

    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    console.error("Delete product error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not delete product"
    });
  }
});

// Read store settings
app.get("/api/settings", async (req, res) => {
  try {
    await ensureTables();

    const result = await pool.query(
      "SELECT value FROM store_settings WHERE key = $1",
      ["settings"]
    );

    res.json({
      success: true,
      settings: result.rows[0]?.value || {
        store_name: "Vishal Jewellers",
        phone: "",
        whatsapp: "",
        email: "",
        address: "",
        upi_id: "",
        qr_url: ""
      }
    });
  } catch (err) {
    console.error("Read settings error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load settings"
    });
  }
});

// Admin: update settings
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    await ensureTables();

    const settings = req.body?.settings;

    if (!settings || typeof settings !== "object" ||
        Array.isArray(settings)) {
      return res.status(400).json({
        success: false,
        message: "Invalid settings"
      });
    }

    await pool.query(
      `INSERT INTO store_settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value`,
      ["settings", JSON.stringify(settings)]
    );

    res.json({ success: true, settings });
  } catch (err) {
    console.error("Save settings error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not save settings"
    });
  }
});
// Admin: upload an image to Cloudinary
app.post(
  "/api/upload-image",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please select an image"
        });
      }

      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(500).json({
          success: false,
          message: "Cloudinary environment variables are missing"
        });
      }

      const imageUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: "vishal-jewellers",
            resource_type: "image"
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result.secure_url);
          }
        );

        stream.end(req.file.buffer);
      });

      res.json({ success: true, url: imageUrl });
    } catch (err) {
      console.error("Image upload error:", err.message);
      res.status(500).json({
        success: false,
        message: "Image upload failed"
      });
    }
  }
);

// Handle unexpected errors
app.use((err, req, res, next) => {
  console.error("Request error:", err.message);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: "Upload failed. Maximum image size is 5 MB."
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: "Server error"
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Vishal Jewellers running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
