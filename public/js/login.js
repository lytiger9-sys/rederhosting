const form = document.querySelector("#loginForm");
const errorMessage = document.querySelector("#loginError");
const submitButton = document.querySelector("#loginButton");

async function checkExistingSession() {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    const result = await response.json();
    if (result.authenticated) window.location.replace("/");
  } catch {
    errorMessage.textContent = "서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  errorMessage.textContent = "";

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "로그인하지 못했습니다.");
    window.location.replace("/");
  } catch (error) {
    errorMessage.textContent = error.message || "로그인하지 못했습니다.";
    form.elements.password.value = "";
    form.elements.password.focus();
  } finally {
    submitButton.disabled = false;
  }
});

checkExistingSession();
