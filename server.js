const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is missing");
}

if (!process.env.ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD environment variable is missing");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "rejected",
];

const PAYMENT_STATUSES = [
  "pending",
  "approved",
  "paid",
  "failed",
  "refunded",
  "rejected",
];

async function initDatabase() {
  // New installations get these tables.
  // Existing tables and their IDs are not dropped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      category TEXT DEFAULT '',
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT DEFAULT '',
      payment_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      store_name TEXT DEFAULT 'Jewellery Store',
      phone TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      currency TEXT DEFAULT 'INR',
      footer_text TEXT DEFAULT '',
      primary_color TEXT DEFAULT '#b8860b',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add missing columns to older installations safely.
  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS image TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);

  await pool.query(`
    INSERT INTO store_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  console.log("Database tables checked successfully");
  }
  
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: "Admin password is not configured",
    });
  }

  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized admin access",
    });
  }

  next();
}

function sendError(res, error, message = "Server error") {
  console.error(message, error);
  return res.status(500).json({
    success: false,
    message,
  });
}

function validProduct(body) {
  const name = String(body.name || "").trim();
  const price = Number(body.price);

  if (!name || !Number.isFinite(price) || price < 0) {
    return null;
  }

  return {
    name,
    price,
    image: String(body.image || ""),
    description: String(body.description || ""),
    category: String(body.category || ""),
    stock: Math.max(0, parseInt(body.stock, 10) || 0),
  };
}

// Health check
app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});

// Admin login
app.post("/api/admin/login", (req, res) => {
  const password = String(req.body.password || "");

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Invalid password",
    });
  }

  // Uses the configured admin password as a simple bearer token.
  // A dedicated expiring session/JWT is recommended for production.
  return res.json({
    success: true,
    token: process.env.ADMIN_PASSWORD,
  });
});

// Read store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_settings WHERE id = 1"
    );

    res.json(result.rows[0] || {});
  } catch (error) {
    sendError(res, error, "Could not load store settings");
  }
});

// Update store settings
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const allowed = [
      "store_name",
      "phone",
      "whatsapp",
      "email",
      "address",
      "currency",
      "footer_text",
      "primary_color",
    ];

    const updates = [];
    const values = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(String(req.body[key]));
        updates.push(`${key} = $${values.length}`);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No settings supplied",
      });
    }

    values.push(1);

    const result = await pool.query(
      `UPDATE store_settings
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    res.json({
      success: true,
      settings: result.rows[0] || null,
    });
  } catch (error) {
    sendError(res, error, "Could not update store settings");
  }
});

// List products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, price, image, category, stock
       FROM products
       ORDER BY created_at DESC NULLS LAST`
    );

    res.json(result.rows);
  } catch (error) {
    sendError(res, error, "Could not load products");
  }
});

// Create product
app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const product = validProduct(req.body);

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Valid product name and price are required",
      });
    }

    const id = crypto.randomUUID();

    const result = await pool.query(
      `INSERT INTO products
       (id, name, description, price, image, category, stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        product.name,
        product.description,
        product.price,
        product.image,
        product.category,
        product.stock,
      ]
    );

    res.status(201).json({
      success: true,
      product: result.rows[0],
    });
  } catch (error) {
    sendError(res, error, "Could not create product");
  }
});

// Update product
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const product = validProduct(req.body);

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Valid product name and price are required",
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET name = $1,
           description = $2,
           price = $3,
           image = $4,
           category = $5,
           stock = $6
       WHERE id::text = $7
       RETURNING *`,
      [
        product.name,
        product.description,
        product.price,
        product.image,
        product.category,
        product.stock,
        req.params.id,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      product: result.rows[0],
    });
  } catch (error) {
    sendError(res, error, "Could not update product");
  }
});

// Delete product
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id::text = $1 RETURNING id",
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({ success: true });
  } catch (error) {
    sendError(res, error, "Could not delete product");
  }
});

function validOrder(body) {
  const customerName = String(body.customer_name || "").trim();
  const phone = String(body.phone || "").trim();
  const address = String(body.address || "").trim();
  const items = body.items;
  const total = Number(body.total);

  if (
    !customerName ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !Number.isFinite(total) ||
    total < 0
  ) {
    return null;
  }

  return {
    customerName,
    phone,
    address,
    items,
    total,
    paymentMethod: String(body.payment_method || ""),
  };
}

// Create order
app.post("/api/orders", async (req, res) => {
  try {
    const order = validOrder(req.body);

    if (!order) {
      return res.status(400).json({
        success: false,
        message: "Valid customer details, items and total are required",
      });
    }

    const id = crypto.randomUUID();

    const result = await pool.query(
      `INSERT INTO orders
       (id, customer_name, phone, address, items, total,
        status, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', $7, 'pending')
       RETURNING *`,
      [
        id,
        order.customerName,
        order.phone,
        order.address,
        JSON.stringify(order.items),
        order.total,
        order.paymentMethod,
      ]
    );

    res.status(201).json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    sendError(res, error, "Could not create order");
  }
});

// List orders for admin
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC NULLS LAST"
    );

    res.json(result.rows);
  } catch (error) {
    sendError(res, error, "Could not load orders");
  }
});

// Update order status
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || "");

    if (!STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status",
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id::text = $2
       RETURNING *`,
      [status, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    sendError(res, error, "Could not update order status");
  }
});

// Update payment status
app.patch("/api/orders/:id/payment", requireAdmin, async (req, res) => {
  try {
    const paymentStatus = String(req.body.payment_status || "");

    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status",
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET payment_status = $1
       WHERE id::text = $2
       RETURNING *`,
      [paymentStatus, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      order: result.rows[0],
    });
  } catch (error) {
    sendError(res, error, "Could not update payment status");
  }
});

// Serve public and admin pages
app.use(express.static("public"));

app.get("/admin.html", (req, res) => {
  res.sendFile(require("path").join(__dirname, "admin.html"));
});

// Handle unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Final error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// Start server only after database initialization
initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
      
