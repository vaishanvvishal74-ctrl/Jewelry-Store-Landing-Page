
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

let settings = {
  storeName: "My Jewellery Store",
  logo: "",
  phone: "",
  whatsapp: "",
  email: "",
  address: "",
  city: "",
  mapLink: "",
  instagram: "",
  facebook: "",
  otherSocial: "",
  upiId: "",
  banner: "",
  primaryColor: "#9b6b43",
  footerText: "Thank you for visiting our store"
};

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
    return res.status(500).json({
      error: "ADMIN_PASSWORD is not configured in Render"
    });
  }

  const password = req.body?.password;

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

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.put("/api/settings", requireAdmin, (req, res) => {
  const allowed = Object.keys(settings);
  const updates = req.body || {};

  for (const key of Object.keys(updates)) {
    if (!allowed.includes(key)) {
      return res.status(400).json({
        error: "Unknown setting: " + key
      });
    }

    if (
      typeof updates[key] !== "string" ||
      updates[key].length > 2000
    ) {
      return res.status(400).json({
        error: "Each setting must be text under 2000 characters"
      });
    }
  }

  settings = { ...settings, ...updates };
  res.json({ message: "Settings updated", settings });
});

app.get("/api/products", (req, res) => {
  res.json(products);
});

app.post("/api/products", requireAdmin, (req, res) => {
  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
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

app.put("/api/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const product = products.find(item => item.id === id);

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({ error: "Invalid product details" });
  }

  Object.assign(product, {
    name: name.trim(),
    price: Number(price),
    image: image.trim()
  });

  res.json(product);
});

app.delete("/api/products/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const before = products.length;
  products = products.filter(item => item.id !== id);

  if (products.length === before) {
    return res.status(404).json({ error: "Product not found" });
  }

  res.json({ message: "Product deleted" });
});

app.listen(PORT, () => {
  console.log("Jewellery Store server running on port " + PORT);
});
