document.addEventListener("DOMContentLoaded", () => {
    const hamburger = document.getElementById("hamburger");
    const mobileNav = document.getElementById("mobile-nav");
  
    if (hamburger && mobileNav) {
      hamburger.addEventListener("click", () => {
        mobileNav.classList.toggle("active");
      });
    }
  });