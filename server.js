
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("."));

let products = [];
let nextId = 1;

app.get("/api/health", (req, res) => {
  res.json({ status: "Jewellery Store Server is running" });
});

app.get("/api/products", (req, res) => {
  res.json(products);
});

app.post("/api/products", (req, res) => {
  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" || !name.trim() ||
    !Number.isFinite(Number(price)) || Number(price) < 0 ||
    typeof image !== "string" || !image.trim()
  ) {
    return res.status(400).json({
      error: "Valid name, price and image URL are required"
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
