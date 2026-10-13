
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// Website files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

// Product data storage
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "products.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, "[]", "utf8");
}

function readProducts() {
  return JSON.parse(fs.readFileSync(dataFile, "utf8"));
}

function saveProducts(products) {
  fs.writeFileSync(dataFile, JSON.stringify(products, null, 2));
}

// Check product data
function validProduct(body) {
  return (
    body &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    Number.isFinite(Number(body.price)) &&
    Number(body.price) >= 0
  );
}

// Get all products
app.get("/products", (req, res) => {
  try {
    res.json(readProducts());
  } catch (error) {
    res.status(500).json({ error: "Products load nahi ho paye." });
  }
});

// Add product
app.post("/products", (req, res) => {
  try {
    if (!validProduct(req.body)) {
      return res.status(400).json({
        error: "Product name aur valid price zaroori hai."
      });
    }

    const products = readProducts();

    const product = {
      id: crypto.randomUUID(),
      name: req.body.name.trim(),
      price: Number(req.body.price),
      image: typeof req.body.image === "string" ? req.body.image.trim() : ""
    };

    products.push(product);
    saveProducts(products);

    res.status(201).json({
      message: "Product save ho gaya.",
      product
    });
  } catch (error) {
    res.status(500).json({ error: "Product save nahi hua." });
  }
});

// Update product
app.put("/products/:id", (req, res) => {
  try {
    if (!validProduct(req.body)) {
      return res.status(400).json({
        error: "Product name aur valid price zaroori hai."
      });
    }

    const products = readProducts();
    const index = products.findIndex(
      product => product.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({ error: "Product nahi mila." });
    }

    products[index] = {
      ...products[index],
      name: req.body.name.trim(),
      price: Number(req.body.price),
      image: typeof req.body.image === "string"
        ? req.body.image.trim()
        : products[index].image
    };

    saveProducts(products);
    res.json({ message: "Product update ho gaya.", product: products[index] });
  } catch (error) {
    res.status(500).json({ error: "Product update nahi hua." });
  }
});

// Delete product
app.delete("/products/:id", (req, res) => {
  try {
    const products = readProducts();
    const remaining = products.filter(
      product => product.id !== req.params.id
    );

    if (remaining.length === products.length) {
      return res.status(404).json({ error: "Product nahi mila." });
    }

    saveProducts(remaining);
    res.json({ message: "Product delete ho gaya." });
  } catch (error) {
    res.status(500).json({ error: "Product delete nahi hua." });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Jewellery Store server running on port ${PORT}`);
});
