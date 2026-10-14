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

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

// Cloudinary image hosting
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Image upload: maximum 5 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Only JPG, PNG, WEBP or GIF images are allowed"));
    }

    callback(null, true);
  }
});

// In-memory admin sessions
const sessions = new Map();

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function requireAdmin(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
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

// Accept both older and newer admin API route formats
function adminRoute(handler) {
  return [requireAdmin, handler];
}

// Initialize database tables and safely add newer columns
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

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

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
      announcement TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE store_settings
      ADD COLUMN IF NOT EXISTS announcement TEXT DEFAULT '';

    INSERT INTO store_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// Convert database product rows into a consistent API format
function formatProduct(row) {
  return {
    ...row,
    image_url: row.image || "",
    featured: Boolean(row.featured),
    active: row.active !== false
  };
}

// Serve website files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      database: "connected"
    });
  } catch (error) {
    console.error("Health check failed:", error.message);

    res.status(500).json({
      success: false,
      database: "error"
    });
  }
});

// Admin login
app.post("/api/admin/login", (req, res) => {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = String(req.body?.password ?? "");

  if (!expectedPassword) {
    return res.status(500).json({
      success: false,
      message: "ADMIN_PASSWORD is missing in Render"
    });
  }

  const supplied = Buffer.from(suppliedPassword);
  const expected = Buffer.from(expectedPassword);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      success: false,
      message: "Incorrect password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    expiresAt: Date.now() + 8 * 60 * 60 * 1000
  });

  res.json({
    success: true,
    token
  });
});

// Check current admin session
app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({
    success: true,
    admin: true,
    authenticated: true
  });
});

// Admin logout
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);

  res.json({ success: true });
});

// List public products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM products
      WHERE active = TRUE
      ORDER BY created_at DESC
    `);

    res.json(result.rows.map(formatProduct));
  } catch (error) {
    console.error("Load products failed:", error);

    res.status(500).json({
      message: "Could not load products"
    });
  }
});

// List all products for the admin panel
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );

    res.json(result.rows.map(formatProduct));
  } catch (error) {
    console.error("Admin products failed:", error);

    res.status(500).json({
      message: "Could not load products"
    });
  }
});
// ===============================
// PART 2/3 — PRODUCT, IMAGE, ORDER APIs
// ===============================

// Add product
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 150);
    const description = cleanText(req.body?.description, 2000);
    const price = Number(req.body?.price);
    const image = cleanText(
      req.body?.image_url ?? req.body?.image, 2000
    );
    const category = cleanText(
      req.body?.category || "Jewellery", 100
    );
    const stock = Number.parseInt(req.body?.stock ?? 0, 10);
    const featured = req.body?.featured === true ||
      req.body?.featured === "true";
    const active = req.body?.active !== false &&
      req.body?.active !== "false";

    if (!name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid product name and price are required"
      });
    }

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a non-negative whole number"
      });
    }

    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, image, category, stock, featured, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [name, description, price, image, category, stock, featured, active]
    );

    res.status(201).json({
      success: true,
      product: formatProduct(result.rows[0])
    });
  } catch (error) {
    console.error("Add product failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not add product"
    });
  }
});

// Update product
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID"
      });
    }

    const existing = await pool.query(
      "SELECT * FROM products WHERE id = $1",
      [id]
    );

    if (!existing.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const old = existing.rows[0];
    const body = req.body || {};

    const name = body.name !== undefined
      ? cleanText(body.name, 150) : old.name;

    const description = body.description !== undefined
      ? cleanText(body.description, 2000) : old.description;

    const price = body.price !== undefined
      ? Number(body.price) : Number(old.price);

    const image = body.image_url !== undefined || body.image !== undefined
      ? cleanText(body.image_url ?? body.image, 2000)
      : old.image;

    const category = body.category !== undefined
      ? cleanText(body.category, 100) : old.category;

    const stock = body.stock !== undefined
      ? Number.parseInt(body.stock, 10) : old.stock;

    const featured = body.featured !== undefined
      ? (body.featured === true || body.featured === "true")
      : old.featured;

    const active = body.active !== undefined
      ? !(body.active === false || body.active === "false")
      : old.active;

    if (!name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid product name and price are required"
      });
    }

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a non-negative whole number"
      });
    }

    const result = await pool.query(
      `UPDATE products
       SET name=$1, description=$2, price=$3, image=$4,
           category=$5, stock=$6, featured=$7, active=$8
       WHERE id=$9
       RETURNING *`,
      [
        name, description, price, image, category,
        stock, featured, active, id
      ]
    );

    res.json({
      success: true,
      product: formatProduct(result.rows[0])
    });
  } catch (error) {
    console.error("Update product failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not update product"
    });
  }
});

// Delete product
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID"
      });
    }

    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 RETURNING id",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    res.json({
      success: true,
      message: "Product deleted"
    });
  } catch (error) {
    console.error("Delete product failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not delete product"
    });
  }
});

// Upload product image
app.post("/api/upload-image", requireAdmin, (req, res) => {
  upload.single("image")(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({
        success: false,
        message: uploadError.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please select an image"
      });
    }

    try {
      const uploadedImage = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "vishal-jewellers", resource_type: "image" },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );

        stream.end(req.file.buffer);
      });

      res.json({
        success: true,
        url: uploadedImage.secure_url,
        image_url: uploadedImage.secure_url
      });
    } catch (error) {
      console.error("Image upload failed:", error);
      res.status(500).json({
        success: false,
        message: "Image upload failed. Check Cloudinary settings."
      });
    }
  });
});

// Place order
app.post("/api/orders", async (req, res) => {
  try {
    const customerName = cleanText(req.body?.customer_name, 150);
    const email = cleanText(req.body?.email, 200);
    const phone = cleanText(req.body?.phone, 30);
    const address = cleanText(req.body?.address, 1000);
    const paymentMethod = cleanText(
      req.body?.payment_method || "cod", 30
    ).toLowerCase();

    const incomingItems = req.body?.items;

    if (
      !customerName || !phone || !address ||
      !Array.isArray(incomingItems) ||
      incomingItems.length === 0 ||
      incomingItems.length > 50
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide customer details and order items"
      });
    }

    const items = [];
    let total = 0;

    for (const item of incomingItems) {
      const productId = Number.parseInt(
        item.product_id ?? item.id, 10
      );
      const quantity = Number.parseInt(item.quantity, 10);

      if (
        !Number.isInteger(productId) || productId < 1 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product or quantity"
        });
      }

      const productResult = await pool.query(
        "SELECT * FROM products WHERE id=$1 AND active=TRUE",
        [productId]
      );

      if (!productResult.rowCount) {
        return res.status(400).json({
          success: false,
          message: "One of the selected products is unavailable"
        });
      }

      const product = productResult.rows[0];
      const unitPrice = Number(product.price);

      items.push({
        product_id: product.id,
        name: product.name,
        price: unitPrice,
        quantity,
        image_url: product.image || ""
      });

      total += unitPrice * quantity;
    }

    const result = await pool.query(
      `INSERT INTO orders
       (customer_name, email, phone, address, items, total,
        payment_method, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'Pending')
       RETURNING *`,
      [
        customerName, email, phone, address,
        JSON.stringify(items), total, paymentMethod
      ]
    );

    res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Place order failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not place order"
    });
  }
});

// Get orders — admin only
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Load orders failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not load orders"
    });
  }
});
// ===============================
// PART 3/3 — ORDER STATUS, SETTINGS, SERVER START
// ===============================

// Update order status — admin only
app.put("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const status = cleanText(req.body?.status, 30);

    const allowedStatuses = [
      "Pending",
      "Confirmed",
      "Processing",
      "Shipped",
      "Delivered",
      "Cancelled"
    ];

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID"
      });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status"
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    res.json({
      success: true,
      message: "Order status updated",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Update order status failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not update order status"
    });
  }
});


// Get store settings — public
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_settings WHERE id = 1"
    );

    res.json(result.rows[0] || {});
  } catch (error) {
    console.error("Load settings failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not load store settings"
    });
  }
});


// Update store settings — admin only
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const storeName = cleanText(
      body.store_name || "Vishal Jewellers", 150
    );
    const phone = cleanText(body.phone, 30);
    const email = cleanText(body.email, 200);
    const address = cleanText(body.address, 1000);
    const upiId = cleanText(body.upi_id, 150);
    const qrImage = cleanText(
      body.qr_image ?? body.upi_qr_url, 2000
    );
    const announcement = cleanText(body.announcement, 500);

    const result = await pool.query(
      `INSERT INTO store_settings
       (id, store_name, phone, email, address, upi_id,
        qr_image, announcement, updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (id)
       DO UPDATE SET
         store_name = EXCLUDED.store_name,
         phone = EXCLUDED.phone,
         email = EXCLUDED.email,
         address = EXCLUDED.address,
         upi_id = EXCLUDED.upi_id,
         qr_image = EXCLUDED.qr_image,
         announcement = EXCLUDED.announcement,
         updated_at = NOW()
       RETURNING *`,
      [
        storeName, phone, email, address,
        upiId, qrImage, announcement
      ]
    );

    res.json({
      success: true,
      message: "Store settings saved",
      settings: result.rows[0]
    });
  } catch (error) {
    console.error("Save settings failed:", error);
    res.status(500).json({
      success: false,
      message: "Could not save store settings"
    });
  }
});


// Handle unknown API routes
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API route not found"
  });
});


// Handle unexpected errors
app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});


// Start server after database initialization
async function startServer() {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Vishal Jewellers server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
