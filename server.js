
require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  }
});

const sessions = new Map();

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      category TEXT DEFAULT 'Jewellery',
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      payment_method TEXT DEFAULT 'cod',
      status TEXT DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      store_name TEXT DEFAULT 'Vishal Jewellers',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      upi_id TEXT DEFAULT '',
      qr_image TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    INSERT INTO store_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({
      success: false,
      message: "Please login again"
    });
  }

  next();
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, database: "connected" });
  } catch {
    res.status(500).json({
      success: false,
      database: "error"
    });
  }
});

// Admin login
app.post("/api/admin/login", (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  const supplied = String(req.body?.password ?? "");

  if (!expected) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_PASSWORD is missing in Render"
    });
  }

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      success: false,
      message: "Incorrect password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  });

  res.json({ success: true, token });
});

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, admin: true });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
  res.json({ success: true });
});

// Public products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not load products" });
  }
});

// Create product
app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const { name, description, price, image, category, stock } = req.body;

    if (!cleanText(name, 150) || !Number.isFinite(Number(price)) ||
        Number(price) < 0) {
      return res.status(400).json({
        message: "Valid product name and price are required"
      });
    }

    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, image, category, stock)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        cleanText(name, 150),
        cleanText(description, 2000),
        Number(price),
        cleanText(image, 2000),
        cleanText(category, 100) || "Jewellery",
        Math.max(0, parseInt(stock, 10) || 0)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not create product" });
  }
});

// Update product
app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const { name, description, price, image, category, stock } = req.body;

    if (!cleanText(name, 150) || !Number.isFinite(Number(price)) ||
        Number(price) < 0) {
      return res.status(400).json({ message: "Invalid product details" });
    }

    const result = await pool.query(
      `UPDATE products SET name=$1, description=$2, price=$3,
       image=$4, category=$5, stock=$6 WHERE id=$7 RETURNING *`,
      [
        cleanText(name, 150),
        cleanText(description, 2000),
        Number(price),
        cleanText(image, 2000),
        cleanText(category, 100) || "Jewellery",
        Math.max(0, parseInt(stock, 10) || 0),
        Number(req.params.id)
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not update product" });
  }
});

// Delete product
app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 RETURNING id",
      [Number(req.params.id)]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not delete product" });
  }
});

// Upload a product image to Cloudinary
app.post(
  "/api/upload-image",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Select an image first" });
      }

      if (!process.env.CLOUDINARY_CLOUD_NAME ||
          !process.env.CLOUDINARY_API_KEY ||
          !process.env.CLOUDINARY_API_SECRET) {
        return res.status(500).json({
          message: "Cloudinary environment variables are missing"
        });
      }

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "vishal-jewellers" },
          (error, uploaded) => error ? reject(error) : resolve(uploaded)
        );
        stream.end(req.file.buffer);
      });

      res.json({ success: true, url: result.secure_url });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Image upload failed" });
    }
  }
);

// Place an order
app.post("/api/orders", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      customer_name, name, email, phone, address,
      items, payment_method
    } = req.body;

    const customerName = cleanText(customer_name || name, 150);
    const customerPhone = cleanText(phone, 30);
    const customerAddress = cleanText(address, 1000);

    if (!customerName || !customerPhone || !customerAddress ||
        !Array.isArray(items) || items.length === 0 ||
        items.length > 50) {
      return res.status(400).json({
        message: "Please provide customer details and items"
      });
    }

    await client.query("BEGIN");

    const verifiedItems = [];
    let total = 0;

    for (const item of items) {
      const id = Number(item.id);
      const quantity = Math.floor(Number(item.quantity));

      if (!Number.isInteger(id) || !Number.isInteger(quantity) ||
          quantity < 1 || quantity > 100) {
        throw new Error("Invalid order item");
      }

      const product = await client.query(
        "SELECT id, name, price, image, stock FROM products WHERE id=$1",
        [id]
      );

      if (!product.rowCount) throw new Error("A product no longer exists");

      const p = product.rows[0];
      if (quantity > Number(p.stock)) {
        throw new Error("Insufficient stock for " + p.name);
      }

      verifiedItems.push({
        id: p.id,
        name: p.name,
        price: Number(p.price),
        image: p.image,
        quantity
      });

      total += Number(p.price) * quantity;

      await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2",
        [quantity, id]
      );
    }

    const method = payment_method === "upi" ? "upi" : "cod";

    const result = await client.query(
      `INSERT INTO orders
       (customer_name, email, phone, address, items, total, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, total, status`,
      [
        customerName,
        cleanText(email, 200),
        customerPhone,
        customerAddress,
        JSON.stringify(verifiedItems),
        total,
        method
      ]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, order: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

// Admin orders
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not load orders" });
  }
});

app.put("/api/orders/:id/status", requireAdmin, async (req, res) => {
  const allowed = ["Pending", "Confirmed", "Shipped", "Delivered", "Cancelled"];
  const status = cleanText(req.body.status, 30);

  if (!allowed.includes(status)) {
    return res.status(400).json({ message: "Invalid order status" });
  }

  try {
    const result = await pool.query(
      "UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",
      [status, Number(req.params.id)]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not update order" });
  }
});

// Store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT store_name, phone, email, address, upi_id, qr_image FROM store_settings WHERE id=1"
    );
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not load settings" });
  }
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const { store_name, phone, email, address, upi_id, qr_image } = req.body;

    const result = await pool.query(
      `UPDATE store_settings SET store_name=$1, phone=$2, email=$3,
       address=$4, upi_id=$5, qr_image=$6, updated_at=NOW()
       WHERE id=1 RETURNING *`,
      [
        cleanText(store_name, 150),
        cleanText(phone, 30),
        cleanText(email, 200),
        cleanText(address, 500),
        cleanText(upi_id, 150),
        cleanText(qr_image, 2000)
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Could not save settings" });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ message: "Request could not be processed" });
});

initDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Vishal Jewellers server running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
    
