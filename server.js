res.json({
      message: "Settings saved",
      settings
    });
  } catch (error) {
    console.error("Save settings failed:", error.message);

    res.status(500).json({
      error: "Could not save settings"
    });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, price, image FROM products ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Read products failed:", error.message);

    res.status(500).json({
      error: "Could not load products"
    });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  const { name, price, image } = req.body || {};

  if (
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === null ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({
      error: "Enter a product name, valid price and HTTPS image URL"
    });
  }

  try {
    const result = await pool.query(
      INSERT INTO products (name, price, image)
       VALUES ($1, $2, $3)
       RETURNING id, name, price, image,
      [name.trim(), Number(price), image.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add product failed:", error.message);

    res.status(500).json({
      error: "Could not add product"
    });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  const { name, price, image } = req.body || {};
  const id = Number(req.params.id);

  if (
    !Number.isInteger(id) ||
    id < 1 ||
    typeof name !== "string" ||
    !name.trim() ||
    price === "" ||
    price === null ||
    price === undefined ||
    !Number.isFinite(Number(price)) ||
    Number(price) < 0 ||
    typeof image !== "string" ||
    !/^https:\/\/\S+$/i.test(image.trim())
  ) {
    return res.status(400).json({
      error: "Invalid product details"
    });
  }

  try {
    const result = await pool.query(
      UPDATE products
       SET name = $1, price = $2, image = $3
       WHERE id = $4
       RETURNING id, name, price, image,
      [name.trim(), Number(price), image.trim(), id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product failed:", error.message);

    res.status(500).json({
      error: "Could not update product"
    });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid product ID"
    });
  }

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    res.json({ message: "Product deleted" });
  } catch (error) {
    console.error("Delete product failed:", error.message);

    res.status(500).json({
      error: "Could not delete product"
    });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        "Jewellery Store server running on port " + PORT
      );
    });
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error.message
    );
    process.exit(1);
  });
