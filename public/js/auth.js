document.addEventListener("DOMContentLoaded", () => {
    const hamburger = document.getElementById("hamburger");
    const mobileNav = document.getElementById("mobile-nav");
    const navLinks = document.querySelectorAll(".nav-link");
  
    if (hamburger && mobileNav) {
      hamburger.addEventListener("click", () => {
        mobileNav.classList.toggle("active");
      });
    }

    navLinks.forEach(link => {
        link.addEventListener("click", () => {
          mobileNav.classList.remove("active");
          console.log("リンククリックでメニューを閉じました。");
        });
    });
  });