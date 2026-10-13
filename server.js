const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({ status: "Jewellery Store Server is running" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
