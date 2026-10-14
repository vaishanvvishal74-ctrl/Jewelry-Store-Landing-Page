"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// Serve the website's main pages from the project root.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Serve any other static files in the public folder.
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

pool.on("error", (error) => {
  console.error("Database connection error:", error.message);
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return callback(new Error("Only image files are allowed."));
    }
    callback(null, true);
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    store: "Vishal Jewellers",
    message: "Server is running"
  });
});

// Database check
app.get("/api/db-status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, database: "connected" });
  } catch (error) {
    console.error("Database check failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Database connection failed"
    });
  }
});
app.get("/api/settings", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    const result = await pool.query(
      "SELECT value FROM store_settings WHERE key = $1",
      ["settings"]
    );

    const settings = result.rows.length
      ? result.rows[0].value
      : {
          store_name: "Vishal Jewellers",
          upi_id: "",
          qr_url: ""
        };

    res.json({ success: true, settings });
  } catch (error) {
    console.error("Settings read failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load store settings"
    });
  }
});

// IMPORTANT: protect this route with admin authentication
// before using store settings in production.
app.put("/api/settings", async (req, res) => {
  try {
    const settings = req.body.settings;

    if (!settings || typeof settings !== "object" ||
        Array.isArray(settings)) {
      return res.status(400).json({
        success: false,
        message: "Invalid settings data"
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await pool.query(
      `INSERT INTO store_settings (key, value)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value`,
      ["settings", JSON.stringify(settings)]
    );

    res.json({ success: true, settings });
  } catch (error) {
    console.error("Settings save failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not save settings"
    });
  }
});

// Image upload
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
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
  } catch (error) {
    console.error("Image upload failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Image upload failed"
    });
  }
});

// List products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id DESC"
    );

    res.json({
      success: true,
      products: result.rows
    });
  } catch (error) {
    console.error("Products read failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Could not load products"
    });
  }
});
app.post("/api/orders", async (req, res) => {
  const {
    customer_name,
    phone,
    address,
    items,
    total,
    payment_method
  } = req.body || {};

  if (
    !customer_name ||
    !phone ||
    !address ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide customer details and order items"
    });
  }

  const method = String(payment_method || "COD").toUpperCase();

  if (!["COD", "UPI"].includes(method)) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment method"
    });
  }

  const orderTotal = Number(total);

  if (!Number.isFinite(orderTotal) || orderTotal < 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid order total"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        customer_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        items JSONB NOT NULL,
        total NUMERIC(12,2) NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'COD',
        payment_status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const result = await client.query(
      `INSERT INTO orders
       (customer_name, phone, address, items, total,
        payment_method, payment_status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, payment_method, payment_status`,
      [
        String(customer_name).trim(),
        String(phone).trim(),
        String(address).trim(),
        JSON.stringify(items),
        orderTotal,
        method,
        "PENDING"
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Order received",
      order: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Order creation failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Could not place order"
    });
  } finally {
    client.release();
  }
});

// Handle JSON and image-upload errors
app.use((error, req, res, next) => {
  console.error("Request error:", error.message);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: "Image upload failed. Maximum size is 10 MB."
    });
  }

  if (error.status === 413) {
    return res.status(413).json({
      success: false,
      message: "Request is too large"
    });
  }

  res.status(error.status || 500).json({
    success: false,
    message: "Internal server error"
  });
});

const server = app.listen(PORT, () => {
  console.log(`Vishal Jewellers server running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
