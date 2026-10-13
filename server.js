
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

// Admin password: Render Environment में ADMIN_PASSWORD सेट करें
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const sessions = new Set();

// Website files
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"), (err) => {
    if (err && !res.headersSent) {
      res.status(404).send(
        "index.html nahi mila. GitHub repository ke root mein index.html rakhein."
      );
    }
  });
});

// Admin page
app.get("/admin.html", (req, res) => {
  const publicAdmin = path.join(PUBLIC_DIR, "admin.html");
  const rootAdmin = path.join(__dirname, "admin.html");

  res.sendFile(
    require("fs").existsSync(publicAdmin) ? publicAdmin : rootAdmin,
    (err) => {
      if (err && !res.headersSent) {
        res.status(404).send("admin.html nahi mila.");
      }
    }
  );
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    databaseConfigured: Boolean(pool)
  });
});

// Database setup
async function setupDatabase() {
  if (!pool) {
    console.log("DATABASE_URL missing. Database API unavailable.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      category TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      items JSONB DEFAULT '[]'::jsonb,
      total NUMERIC(12,2) DEFAULT 0,
      status TEXT DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Database tables ready.");
}

// Database guard
function requireDatabase(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: "Database configured nahi hai. Render par DATABASE_URL set karein."
    });
  }
  next();
}

// Admin authentication
function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Admin login required." });
  }

  next();
}

// Admin login
app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Render Environment mein ADMIN_PASSWORD set karein."
    });
  }

  const password = String(req.body.password || "");

  const provided = Buffer.from(password);
  const expected = Buffer.from(ADMIN_PASSWORD);

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({ error: "Wrong password." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);

  res.json({ success: true, token });
});

// Admin logout
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  sessions.delete(req.get("x-admin-token"));
  res.json({ success: true });
});

// Verify admin session
app.get("/api/admin/check", requireAdmin, (req, res) => {
  res.json({ success: true, loggedIn: true });
});

// Get all products
app.get("/api/products", requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Products error:", err.message);
    res.status(500).json({ error: "Products load nahi hue." });
  }
});

// Add product (admin only)
app.post(
  "/api/products",
  requireDatabase,
  requireAdmin,
  async (req, res) => {
    try {
      const { name, description, price, image, category } = req.body;

      if (!name || price === undefined || !Number.isFinite(Number(price)) ||
          Number(price) < 0) {
        return res.status(400).json({
          error: "Valid product name aur price zaroori hain."
        });
      }

      const result = await pool.query(
        `INSERT INTO products (name, description, price, image, category)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          String(name).trim(),
          description || "",
          Number(price),
          image || "",
          category || ""
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("Add product error:", err.message);
      res.status(500).json({ error: "Product add nahi hua." });
    }
  }
);

// Update product (admin only)
app.put(
  "/api/products/:id",
  requireDatabase,
  requireAdmin,
  async (req, res) => {
    try {
      const { name, description, price, image, category } = req.body;

      if (!name || !Number.isFinite(Number(price)) || Number(price) < 0) {
        return res.status(400).json({ error: "Name aur valid price dein." });
      }

      const result = await pool.query(
        `UPDATE products
         SET name=$1, description=$2, price=$3, image=$4, category=$5
         WHERE id=$6 RETURNING *`,
        [
          String(name).trim(),
          description || "",
          Number(price),
          image || "",
          category || "",
          req.params.id
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "Product nahi mila." });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Update product error:", err.message);
      res.status(500).json({ error: "Product update nahi hua." });
    }
  }
);

// Delete product (admin only)
app.delete(
  "/api/products/:id",
  requireDatabase,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM products WHERE id=$1 RETURNING id",
        [req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "Product nahi mila." });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("Delete product error:", err.message);
      res.status(500).json({ error: "Product delete nahi hua." });
    }
  }
);

// Create customer order
app.post("/api/orders", requireDatabase, async (req, res) => {
  try {
    const { customer_name, phone, address, items, total } = req.body;

    if (
      !customer_name ||
      !Array.isArray(items) ||
      !Number.isFinite(Number(total)) ||
      Number(total) < 0
    ) {
      return res.status(400).json({ error: "Order details invalid hain." });
    }

    const result = await pool.query(
      `INSERT INTO orders
       (customer_name, phone, address, items, total)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status, created_at`,
      [
        String(customer_name).trim(),
        phone || "",
        address || "",
        JSON.stringify(items),
        Number(total)
      ]
    );

    res.status(201).json({
      success: true,
      order: result.rows[0]
    });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ error: "Order save nahi hua." });
  }
});

// View orders (admin only)
app.get(
  "/api/orders",
  requireDatabase,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM orders ORDER BY id DESC"
      );
      res.json(result.rows);
    } catch (err) {
      console.error("Orders error:", err.message);
      res.status(500).json({ error: "Orders load nahi hue." });
    }
  }
);

// Update order status (admin only)
app.patch(
  "/api/orders/:id",
  requireDatabase,
  requireAdmin,
  async (req, res) => {
    try {
      const allowed = ["Pending", "Confirmed", "Shipped", "Delivered", "Cancelled"];
      const { status } = req.body;

      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "Invalid order status." });
      }

      const result = await pool.query(
        "UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",
        [status, req.params.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "Order nahi mila." });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error("Order status error:", err.message);
      res.status(500).json({ error: "Status update nahi hua." });
    }
  }
);

// Unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route nahi mila." });
});

// Start server
async function startServer() {
  try {
    await setupDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Jewellery Store running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Database setup failed:", err.message);
    process.exit(1);
  }
}

startServer();
  
