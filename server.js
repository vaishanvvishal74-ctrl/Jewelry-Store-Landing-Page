
"use strict";

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

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

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const sessions = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;

const STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "rejected"
];

const PAYMENT_STATUSES = ["pending", "approved", "rejected"];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(
        new Error("JPG, PNG, WebP ya AVIF image hi upload karein.")
      );
    }

    cb(null, true);
  }
});

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

  if (!header.startsWith("Bearer ")) {
    return "";
  }

  return header.slice(7);
}

function requireAdmin(req, res, next) {
  const token = getToken(req);
  const expires = sessions.get(token);

  if (!token || !expires || expires < Date.now()) {
    if (token) sessions.delete(token);

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

function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        folder: "jewellery-store/products",
        resource_type: "image",
        transformation: [
          {
            width: 2000,
            height: 2000,
            crop: "limit"
          },
          {
            quality: "auto",
            fetch_format: "auto"
          }
        ]
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    ).end(buffer);
  });
}

// DATABASE INITIALIZATION
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

  // Purane database mein missing settings columns add karein.
  await pool.query(`
    ALTER TABLE store_settings
      ADD COLUMN IF NOT EXISTS store_name TEXT NOT NULL DEFAULT 'Jewellery Store',
      ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS whatsapp TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS instagram TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS google_maps TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS upi_id TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS qr_url TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  // Check karein ki purana "data" column hai ya nahi.
  const legacy = await pool.query(`
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'store_settings'
      AND column_name = 'data'
    LIMIT 1
  `);

  if (legacy.rowCount > 0) {
    const type = legacy.rows[0].udt_name;

    if (type === "json" || type === "jsonb") {
      await pool.query(`
        UPDATE store_settings
        SET data = '{}'::jsonb
        WHERE data IS NULL
      `);
    } else if (type === "text" || type === "varchar") {
      await pool.query(`
        UPDATE store_settings
        SET data = '{}'
        WHERE data IS NULL
      `);
    } else {
      throw new Error(
        "Legacy store_settings.data ka type unexpected hai. Database schema check karein."
      );
    }

    await pool.query(`
      INSERT INTO store_settings (id, store_name, data)
      VALUES (1, 'Jewellery Store', '{}'::${type === "json" ? "json" : type === "jsonb" ? "jsonb" : "text"})
      ON CONFLICT (id) DO NOTHING
    `);
  } else {
    await pool.query(`
      INSERT INTO store_settings (id, store_name)
      VALUES (1, 'Jewellery Store')
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

// ADMIN LOGIN
app.post("/api/admin/login", (req, res) => {
  const password =
    typeof req.body.password === "string"
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

app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ authenticated: true });
});

app.post("/api/admin/logout", (req, res) => {
  sessions.delete(getToken(req));
  res.json({ message: "Logout ho gaya." });
});

// CLOUDINARY IMAGE UPLOAD
app.post("/api/admin/upload", requireAdmin, (req, res) => {
  imageUpload.single("image")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        error: err.message || "Image upload error."
      });
    }

    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(500).json({
        error: "Cloudinary environment variables Render par set karein."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Photo select karein."
      });
    }

    try {
      const result = await uploadBufferToCloudinary(req.file.buffer);

      res.json({
        message: "Image upload ho gayi.",
        url: result.secure_url
      });
    } catch (error) {
      console.error("Cloudinary upload error:", error.message);

      res.status(500).json({
        error: "Photo upload nahi hui. Cloudinary settings check karein."
      });
    }
  });
});

// GET STORE SETTINGS
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

// SAVE STORE SETTINGS
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

    for (const field of ["instagram", "google_maps"]) {
      if (
        values[field] &&
        (!validImageUrl(values[field]) || values[field].length > 2000)
      ) {
        return res.status(400).json({
          error: field + " ke liye valid HTTPS URL dein."
        });
      }
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
        store_name=$1,
        logo_url=$2,
        whatsapp=$3,
        instagram=$4,
        phone=$5,
        email=$6,
        address=$7,
        google_maps=$8,
        upi_id=$9,
        qr_url=$10,
        updated_at=NOW()
       WHERE id=1
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

// LIST PRODUCTS
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

// ADD PRODUCT
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

// UPDATE PRODUCT
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    if (!validProduct(req.body) || !validImageUrl(req.body.image)) {
      return res.status(400).json({
        error: "Valid name, price aur HTTPS image URL zaroori hai."
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET name=$1, price=$2, image=$3
       WHERE id=$4
       RETURNING id, name, price, image`,
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

// DELETE PRODUCT
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

// LIST ORDERS
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

// UPDATE ORDER STATUS
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

// APPROVE / REJECT PAYMENT
app.patch("/api/orders/:id/payment", requireAdmin, async (req, res) => {
  try {
    const paymentStatus = req.body.payment_status;
    const reference =
      typeof req.body.payment_reference === "string"
        ? req.body.payment_reference.trim().slice(0, 200)
        : null;

    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({
        error: "Invalid payment status."
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET payment_status=$1,
           payment_reference=COALESCE($2, payment_reference)
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

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// ADMIN PAGE
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(400).json({
    error: error.message || "Request error."
  });
});

// START SERVER
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
            
