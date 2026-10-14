

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

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Image upload configuration
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
      return callback(
        new Error("Only JPG, PNG, WEBP or GIF images are allowed")
      );
    }

    callback(null, true);
  }
});

// Admin sessions
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

// Initialize database
async function initDB() {
  // Products table
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
      ADD COLUMN IF NOT EXISTS featured
      BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS active
      BOOLEAN NOT NULL DEFAULT TRUE;

    -- Orders table
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

    -- Create this table only if it does not exist.
    -- Existing table structure will be preserved.
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      store_name TEXT DEFAULT 'Vishal Jewellers',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      upi_id TEXT DEFAULT '',
      qr_image TEXT DEFAULT '',
      announcement TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Older databases may already have this table without a default
  // for its required "data" column.
  const settingsColumns = await pool.query(`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'store_settings'
  `);

  const dataColumn = settingsColumns.rows.find(
    column => column.column_name === "data"
  );

  if (dataColumn) {
    // Set a default only when the existing type is JSON/JSONB.
    if (
      dataColumn.data_type === "json" ||
      dataColumn.data_type === "jsonb"
    ) {
      await pool.query(`
        ALTER TABLE store_settings
        ALTER COLUMN data SET DEFAULT '{}'::${dataColumn.data_type}
      `);
    }
  }

  await pool.query(`
    ALTER TABLE store_settings
      ADD COLUMN IF NOT EXISTS announcement TEXT DEFAULT ''
  `);

  // Insert both id and data so the required data field is not NULL.
  // Existing settings rows are not overwritten.
  if (dataColumn) {
    await pool.query(`
      INSERT INTO store_settings (id, data)
      VALUES (1, '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
  } else {
    await pool.query(`
      INSERT INTO store_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

// Normalize product response
function formatProduct(row) {
  return {
    ...row,
    image_url: row.image || "",
    featured: Boolean(row.featured),
    active: row.active !== false
  };
}

// Website homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Admin page
app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Database health check
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

// Check admin session
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

// Public product list
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM products
      WHERE active = TRUE
      ORDER BY created_at DESC
    `);

    res.json(result.rows.map(formatProduct));
  } catch (error) {
    console.error("Load products failed:", error);

    res.status(500).json({
      success: false,
      message: "Could not load products"
    });
  }
});

// Admin product list
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );

    res.json(result.rows.map(formatProduct));
  } catch (error) {
    console.error("Admin products failed:", error);

    res.status(500).json({
      success: false,
      message: "Could not load products"
    });
  }
});

// Add product
app.post(
  "/api/admin/products",
  requireAdmin,
  async (req, res) => {
    try {
      const {
        name,
        description = "",
        price = 0,
        image = "",
        category = "Jewellery",
        stock = 0,
        featured = false
      } = req.body || {};

      const productName = cleanText(name, 200);
      const productPrice = Number(price);
      const productStock = Number(stock);

      if (!productName) {
        return res.status(400).json({
          success: false,
          message: "Product name is required"
        });
      }

      if (
        !Number.isFinite(productPrice) ||
        productPrice < 0 ||
        !Number.isInteger(productStock) ||
        productStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid price and stock"
        });
      }

      const result = await pool.query(
        `INSERT INTO products
          (name, description, price, image, category, stock, featured)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          productName,
          cleanText(description, 2000),
          productPrice,
          cleanText(image, 2000),
          cleanText(category, 100) || "Jewellery",
          productStock,
          Boolean(featured)
        ]
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
  }
);

// Update product
app.put(
  "/api/admin/products/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID"
        });
      }

      const {
        name,
        description = "",
        price = 0,
        image = "",
        category = "Jewellery",
        stock = 0,
        featured = false,
        active = true
      } = req.body || {};

      const productName = cleanText(name, 200);
      const productPrice = Number(price);
      const productStock = Number(stock);

      if (
        !productName ||
        !Number.isFinite(productPrice) ||
        productPrice < 0 ||
        !Number.isInteger(productStock) ||
        productStock < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Check product name, price and stock"
        });
      }

      const result = await pool.query(
        `UPDATE products
         SET name = $1,
             description = $2,
             price = $3,
             image = $4,
             category = $5,
             stock = $6,
             featured = $7,
             active = $8
         WHERE id = $9
         RETURNING *`,
        [
          productName,
          cleanText(description, 2000),
          productPrice,
          cleanText(image, 2000),
          cleanText(category, 100) || "Jewellery",
          productStock,
          Boolean(featured),
          active !== false,
          id
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          success: false,
          message: "Product not found"
        });
      }

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
  }
);

// Delete product
app.delete(
  "/api/admin/products/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
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
  }
);

// Get store settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM store_settings WHERE id = 1"
    );

    if (!result.rowCount) {
      return res.json({
        success: true,
        settings: {
          store_name: "Vishal Jewellers",
          phone: "",
          email: "",
          address: "",
          upi_id: "",
          qr_image: "",
          announcement: ""
        }
      });
    }

    const row = result.rows[0];
    const data =
      row.data && typeof row.data === "object"
        ? row.data
        : {};

    res.json({
      success: true,
      settings: {
        ...data,
        store_name: row.store_name || data.store_name || "Vishal Jewellers",
        phone: row.phone || data.phone || "",
        email: row.email || data.email || "",
        address: row.address || data.address || "",
        upi_id: row.upi_id || data.upi_id || "",
        qr_image: row.qr_image || data.qr_image || "",
        announcement: row.announcement || data.announcement || ""
      }
    });
  } catch (error) {
    console.error("Get settings failed:", error);

    res.status(500).json({
      success: false,
      message: "Could not load store settings"
    });
  }
});

// Update store settings
app.put(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {
    try {
      const settings = req.body?.settings || req.body || {};

      const storeName =
        cleanText(settings.store_name, 200) || "Vishal Jewellers";
      const phone = cleanText(settings.phone, 50);
      const email = cleanText(settings.email, 200);
      const address = cleanText(settings.address, 1000);
      const upiId = cleanText(settings.upi_id, 200);
      const qrImage = cleanText(settings.qr_image, 2000);
      const announcement = cleanText(settings.announcement, 500);

      const result = await pool.query(
        `UPDATE store_settings
         SET store_name = $1,
             phone = $2,
             email = $3,
             address = $4,
             upi_id = $5,
             qr_image = $6,
             announcement = $7,
             updated_at = NOW()
         WHERE id = 1
         RETURNING *`,
        [
          storeName,
          phone,
          email,
          address,
          upiId,
          qrImage,
          announcement
        ]
      );

      if (!result.rowCount) {
        return res.status(500).json({
          success: false,
          message: "Settings row is missing from database"
        });
      }

      res.json({
        success: true,
        settings: result.rows[0]
      });
    } catch (error) {
      console.error("Update settings failed:", error);

      res.status(500).json({
        success: false,
        message: "Could not save settings"
      });
    }
  }
);

// Upload product image to Cloudinary
app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Select an image first"
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

      res.json({
        success: true,
        url: imageUrl
      });
    } catch (error) {
      console.error("Image upload failed:", error);

      res.status(500).json({
        success: false,
        message: "Image upload failed"
      });
    }
  }
);

// Create customer order
app.post("/api/orders", async (req, res) => {
  try {
    const {
      customer_name,
      email = "",
      phone,
      address,
      items,
      payment_method = "cod"
    } = req.body || {};

    const customerName = cleanText(customer_name, 200);
    const customerPhone = cleanText(phone, 50);
    const customerAddress = cleanText(address, 1000);

    if (
      !customerName ||
      !customerPhone ||
      !customerAddress ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please fill all required order details"
      });
    }

    if (items.length > 50) {
      return res.status(400).json({
        success: false,
        message: "Too many items in one order"
      });
    }

    // Always calculate prices from the database.
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const orderItems = [];
      let total = 0;

      for (const item of items) {
        const productId = Number(item.id ?? item.product_id);
        const quantity = Number(item.quantity);

        if (
          !Number.isInteger(productId) ||
          productId <= 0 ||
          !Number.isInteger(quantity) ||
          quantity <= 0 ||
          quantity > 100
        ) {
          throw new Error("Invalid product or quantity");
        }

        const productResult = await client.query(
          `SELECT id, name, price, image, stock
           FROM products
           WHERE id = $1 AND active = TRUE
           FOR UPDATE`,
          [productId]
        );

        if (!productResult.rowCount) {
          throw new Error("A selected product is unavailable");
        }

        const product = productResult.rows[0];

        if (Number(product.stock) < quantity) {
          throw new Error(
            "Insufficient stock for " + product.name
          );
        }

        const unitPrice = Number(product.price);
        const lineTotal = unitPrice * quantity;

        total += lineTotal;

        orderItems.push({
          id: product.id,
          name: product.name,
          image: product.image || "",
          price: unitPrice,
          quantity,
          subtotal: lineTotal
        });

        await client.query(
          `UPDATE products
           SET stock = stock - $1
           WHERE id = $2`,
          [quantity, productId]
        );
      }

      const allowedPaymentMethods = ["cod", "upi"];

      const selectedPaymentMethod =
        allowedPaymentMethods.includes(payment_method)
          ? payment_method
          : "cod";

      const result = await client.query(
        `INSERT INTO orders
          (customer_name, email, phone, address,
           items, total, payment_method, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, total, status, created_at`,
        [
          customerName,
          cleanText(email, 200),
          customerPhone,
          customerAddress,
          JSON.stringify(orderItems),
          total,
          selectedPaymentMethod,
          "Pending"
        ]
      );

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "Order placed successfully",
        order: result.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK");

      if (
        error.message === "Invalid product or quantity" ||
        error.message === "A selected product is unavailable" ||
        error.message.startsWith("Insufficient stock")
      ) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }

      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Create order failed:", error);

    res.status(500).json({
      success: false,
      message: "Could not place order"
    });
  }
});

// Admin: list all orders
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );

    res.json({
      success: true,
      orders: result.rows
    });
  } catch (error) {
    console.error("Load orders failed:", error);

    res.status(500).json({
      success: false,
      message: "Could not load orders"
    });
  }
});

// Admin: update order status
app.put(
  "/api/admin/orders/:id/status",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const status = cleanText(req.body?.status, 50);

      const allowedStatuses = [
        "Pending",
        "Confirmed",
        "Processing",
        "Shipped",
        "Delivered",
        "Cancelled"
      ];

      if (
        !Number.isInteger(id) ||
        id <= 0 ||
        !allowedStatuses.includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID or status"
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
        order: result.rows[0]
      });
    } catch (error) {
      console.error("Update order failed:", error);

      res.status(500).json({
        success: false,
        message: "Could not update order"
      });
    }
  }
);

// Admin dashboard summary
app.get(
  "/api/admin/dashboard",
  requireAdmin,
  async (req, res) => {
    try {
      const [products, orders, revenue] = await Promise.all([
        pool.query(
          "SELECT COUNT(*)::int AS count FROM products"
        ),
        pool.query(
          `SELECT COUNT(*)::int AS count
           FROM orders`
        ),
        pool.query(
          `SELECT COALESCE(SUM(total), 0) AS total
           FROM orders
           WHERE status <> 'Cancelled'`
        )
      ]);

      res.json({
        success: true,
        products: products.rows[0].count,
        orders: orders.rows[0].count,
        revenue: Number(revenue.rows[0].total)
      });
    } catch (error) {
      console.error("Dashboard failed:", error);

      res.status(500).json({
        success: false,
        message: "Could not load dashboard"
      });
    }
  }
);

// Handle unknown API endpoints
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found"
  });
});

// Basic error handler
app.use((error, req, res, next) => {
  console.error("Request error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Something went wrong"
  });
});

// Start server only after database initialization
async function startServer() {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
