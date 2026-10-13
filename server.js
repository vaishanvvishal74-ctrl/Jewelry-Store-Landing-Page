
const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.use(express.json({ limit: "20kb" }));
app.use(express.static("."));

const sessions = new Map();
let products = [];
let nextId = 1;

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Please login first" });
  }

  next();
}

app.get("/api/health", (req, res) => {
  res.json({ status: "Jewellery Store Server is running" });
});

app.post("/api/login", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Admin password is not configured" });
  }

  const password = req.body && req.body.password;

  if (
    typeof password !== "string" ||
    password.length !== ADMIN_PASSWORD.length ||
    !crypto.timingSafeEqual(
      Buffer.from(password),
      Buffer.from(ADMIN_PASSWORD)
    )
  ) {
    return res.status(401).json({ error: "Wrong password" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, true);

  res.json({ token });
});

app.post("/api/logout", requireAdmin, (req, res) => {
  sessions.delete(req.get("x-admin-token"));
  res.json({ message: "Logged out" });
});

app.get("/api/products", (req, res) => {
  res.json(products);
});

app.post("/api/products", requireAdmin, (req, res) => {
  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" || !name.trim() ||
    !Number.isFinite(Number(price)) || Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({
      error: "Enter a product name, valid price and HTTPS image URL"
    });
  }

  const product = {
    id: nextId++,
    name: name.trim(),
    price: Number(price),
    image: image.trim()
  };

  products.push(product);
  res.status(201).json(product);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
