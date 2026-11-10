async function logout() {
  await fetch("/logout", {
    method: "POST",
    credentials: "include"
  });

  window.location = "/login";
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    sidebar.classList.toggle("active");
  }
}

async function loadUser() {
  const res = await fetch("/me", {
    credentials: "include"
  });

  if (!res.ok) return;

  const data = await res.json();
  const userDisplay = document.getElementById("userDisplay");

  if (userDisplay) {
    const roleText = data.isAdmin ? " (Admin)" : "";
    userDisplay.textContent = "You are currently logged in as: " + data.email + roleText;
  }

  const adminLinks = document.querySelectorAll(".admin-only-link");
  adminLinks.forEach(link => {
    link.style.display = data.isAdmin ? "block" : "none";
  });
}

function createListingCard(item) {
  const div = document.createElement("div");
  div.className = "card";

  const status = item.status || "Active";
  const interestedCount = item.interestedCount || 0;

  div.innerHTML = `
    <img src="${item.imageLink}" alt="${item.name}">
    <h3>${item.name}</h3>
    <p class="card-description">${item.desc}</p>
    <p class="card-price">$${Number(item.price).toFixed(2)}</p>
    <p class="card-meta">Seller: ${item.sellerName}</p>
    <p class="card-meta">Category: ${item.category || ""}</p>
    <p class="card-meta interested-count">Interested: <span>${interestedCount}</span></p>
    <span class="status-badge">${status}</span>
    <button class="interest-button">I'm interested!</button>
    <p class="interest-message"></p>
  `;

  const button = div.querySelector(".interest-button");
  const message = div.querySelector(".interest-message");
  const countSpan = div.querySelector(".interested-count span");

  if (status !== "Active") {
    button.disabled = true;
  }

  button.addEventListener("click", async () => {
    const res = await fetch("/mark-interest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify({ uuid: item.uuid })
    });

    const contentType = res.headers.get("Content-Type") || "";

    if (res.ok && contentType.includes("application/json")) {
      const data = await res.json();
      countSpan.textContent = data.interestedCount;
      message.textContent = data.message;
      button.disabled = true;
    } else {
      const text = await res.text();
      message.textContent = text;
    }
  });

  return div;
}

function buildListingQuery() {
  const phrase = document.getElementById("filterPhrase");
  const minPrice = document.getElementById("filterMinPrice");
  const maxPrice = document.getElementById("filterMaxPrice");
  const category = document.getElementById("filterCategory");
  const includeSold = document.getElementById("filterIncludeSold");

  const params = new URLSearchParams();

  if (phrase && phrase.value.trim()) params.set("phrase", phrase.value.trim());
  if (minPrice && minPrice.value.trim()) params.set("minPrice", minPrice.value.trim());
  if (maxPrice && maxPrice.value.trim()) params.set("maxPrice", maxPrice.value.trim());
  if (category && category.value.trim()) params.set("category", category.value.trim());
  if (includeSold && includeSold.checked) params.set("includeSold", "true");

  const query = params.toString();
  return query ? `/listings?${query}` : "/listings";
}

async function loadListings() {
  const market = document.getElementById("market");
  if (!market) return;

  const res = await fetch(buildListingQuery(), {
    credentials: "include"
  });

  if (!res.ok) {
    market.innerHTML = "<p>Failed to load listings.</p>";
    return;
  }

  const items = await res.json();
  market.innerHTML = "";

  if (items.length === 0) {
    market.innerHTML = "<p>No listings match your filters.</p>";
    return;
  }

  items.forEach(item => {
    market.appendChild(createListingCard(item));
  });
}

function clearFilters() {
  const phrase = document.getElementById("filterPhrase");
  const minPrice = document.getElementById("filterMinPrice");
  const maxPrice = document.getElementById("filterMaxPrice");
  const category = document.getElementById("filterCategory");
  const includeSold = document.getElementById("filterIncludeSold");

  if (phrase) phrase.value = "";
  if (minPrice) minPrice.value = "";
  if (maxPrice) maxPrice.value = "";
  if (category) category.value = "";
  if (includeSold) includeSold.checked = false;

  loadListings();
}

function selectedFileIsValid(file) {
  if (!file) return false;

  const allowedExtensions = [".heic", ".jpg", ".png"];
  const lowerName = file.name.toLowerCase();

  const hasAllowedExtension = allowedExtensions.some(ext => lowerName.endsWith(ext));
  const isSmallEnough = file.size <= 10 * 1024 * 1024;

  return hasAllowedExtension && isSmallEnough;
}

async function saveItem() {
  const statusEl = document.getElementById("status");
  const fileInput = document.getElementById("imageFile");
  const priceInput = document.getElementById("price");

  if (!fileInput || fileInput.files.length === 0) {
    if (statusEl) statusEl.textContent = "Image required";
    return;
  }

  const file = fileInput.files[0];

  if (!selectedFileIsValid(file)) {
    if (statusEl) {
      statusEl.textContent = "Invalid file. Upload must be .heic, .jpg, or .png and 10MB or smaller.";
    }
    return;
  }

  if (!priceInput || priceInput.value.trim() === "" || Number.isNaN(Number(priceInput.value))) {
    if (statusEl) statusEl.textContent = "Price must be numeric";
    return;
  }

  const form = new FormData();
  form.append("name", document.getElementById("name").value.trim());
  form.append("desc", document.getElementById("desc").value.trim());
  form.append("price", priceInput.value.trim());
  form.append("category", document.getElementById("category").value);
  form.append("image", file);

  const res = await fetch("/save", {
    method: "POST",
    body: form,
    credentials: "include"
  });

  const text = await res.text();

  if (res.ok) {
    document.getElementById("name").value = "";
    document.getElementById("desc").value = "";
    document.getElementById("price").value = "";
    document.getElementById("category").value = "";
    document.getElementById("imageFile").value = "";

    if (statusEl) statusEl.textContent = text;
  } else {
    if (statusEl) statusEl.textContent = text || "Error saving";
  }
}

function createModifyCard(item, options = {}) {
  const div = document.createElement("div");
  div.className = "modify-card";

  div.innerHTML = `
    <div class="modify-image-wrap">
      <img src="${item.imageLink}" alt="${item.name}" class="modify-image">
    </div>

    <p class="card-meta">Interested: ${item.interestedCount || 0}</p>
	<p class="card-meta">Seller: ${item.sellerName || 0}</p>
    <label>Item Name</label>
    <input type="text" class="edit-name" value="${item.name || ""}">

    <label>Description</label>
    <textarea class="edit-desc">${item.desc || ""}</textarea>

    <label>Price</label>
    <input type="number" step="0.01" min="0" class="edit-price" value="${item.price || ""}">

    <label>Category</label>
    <select class="edit-category">
      <option value="">Select Category</option>
      <option ${item.category === "Food/Drink" ? "selected" : ""}>Food/Drink</option>
      <option ${item.category === "Furniture" ? "selected" : ""}>Furniture</option>
      <option ${item.category === "Appliances" ? "selected" : ""}>Appliances</option>
      <option ${item.category === "Transportation" ? "selected" : ""}>Transportation</option>
      <option ${item.category === "Clothing" ? "selected" : ""}>Clothing</option>
      <option ${item.category === "Electronics" ? "selected" : ""}>Electronics</option>
      <option ${item.category === "Other" ? "selected" : ""}>Other</option>
    </select>

    <label>Status</label>
    <select class="edit-status">
      <option ${((item.status || "Active") === "Sold") ? "selected" : ""}>Sold</option>
      <option ${((item.status || "Active") === "Active") ? "selected" : ""}>Active</option>
      <option ${((item.status || "Active") === "Hidden") ? "selected" : ""}>Hidden</option>
    </select>

    <button class="save-edit-button">Save Changes</button>
    ${options.canDelete ? `<button class="delete-listing-button">Delete Listing</button>` : ""}
    <p class="edit-message"></p>
  `;

  const saveButton = div.querySelector(".save-edit-button");
  saveButton.addEventListener("click", async () => {
    const priceValue = div.querySelector(".edit-price").value.trim();

    if (priceValue === "" || Number.isNaN(Number(priceValue))) {
      div.querySelector(".edit-message").textContent = "Price must be numeric";
      return;
    }

    const payload = {
      uuid: item.uuid,
      name: div.querySelector(".edit-name").value.trim(),
      desc: div.querySelector(".edit-desc").value.trim(),
      price: priceValue,
      category: div.querySelector(".edit-category").value,
      status: div.querySelector(".edit-status").value
    };

    const res = await fetch("/update-listing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    div.querySelector(".edit-message").textContent = text;
  });

  if (options.canDelete) {
    const deleteButton = div.querySelector(".delete-listing-button");

    deleteButton.addEventListener("click", async () => {
      const confirmed = confirm("Delete this listing permanently?");
      if (!confirmed) return;

      const res = await fetch("/delete-listing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({ uuid: item.uuid })
      });

      const text = await res.text();

      if (res.ok) {
        div.remove();
      } else {
        div.querySelector(".edit-message").textContent = text;
      }
    });
  }

  return div;
}

async function loadMyListings() {
  const container = document.getElementById("myListings");
  if (!container) return;

  const res = await fetch("/my-listings", {
    credentials: "include"
  });

  if (!res.ok) {
    container.innerHTML = "<p>Failed to load your listings.</p>";
    return;
  }

  const items = await res.json();
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = "<p>You have no listings yet.</p>";
    return;
  }

  items.forEach(item => {
    container.appendChild(createModifyCard(item));
  });
}

async function loadAdminListings() {
  const container = document.getElementById("adminListings");
  if (!container) return;

  const res = await fetch("/admin-listings", {
    credentials: "include"
  });

  if (!res.ok) {
    container.innerHTML = "<p>Failed to load admin listings.</p>";
    return;
  }

  const items = await res.json();
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = "<p>No listings found.</p>";
    return;
  }

  items.forEach(item => {
    container.appendChild(createModifyCard(item, { canDelete: true }));
  });
}

async function banUser() {
  const emailInput = document.getElementById("banEmail");
  const banStatus = document.getElementById("banStatus");

  if (!emailInput || !emailInput.value.trim()) {
    if (banStatus) banStatus.textContent = "Enter an email to ban";
    return;
  }

  const confirmed = confirm("Ban this user? They will be logged out and blocked from logging in or signing up.");
  if (!confirmed) return;

  const res = await fetch("/admin-ban-user", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ email: emailInput.value.trim() })
  });

  const text = await res.text();

  if (banStatus) banStatus.textContent = text;

  if (res.ok) {
    emailInput.value = "";
  }
}

window.onload = () => {
  loadUser();
  loadListings();
  loadMyListings();
  loadAdminListings();
};