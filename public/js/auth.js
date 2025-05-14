document.addEventListener("DOMContentLoaded", () => {
    const hamburger = document.getElementById("hamburger");
    const mobileNav = document.getElementById("mobile-nav");
    const navLinks = document.querySelectorAll(".nav-link");
  
    if (!hamburger || !mobileNav) {
      console.error("ハンバーガーメニューまたはナビゲーションが見つかりません。");
      return;
    }
  
    // ハンバーガーボタンのクリックでメニューをトグル
    hamburger.addEventListener("click", () => {
      mobileNav.classList.toggle("active");
    });
  
    // リンククリックでメニューを閉じる
    navLinks.forEach(link => {
      link.addEventListener("click", () => {
        mobileNav.classList.remove("active");
      });
    });
  
    // メニュー外クリックでメニューを閉じる
    document.addEventListener("click", (event) => {
      const isClickInsideMenu = mobileNav.contains(event.target);
      const isClickOnHamburger = hamburger.contains(event.target);
  
      if (!isClickInsideMenu && !isClickOnHamburger && mobileNav.classList.contains("active")) {
        mobileNav.classList.remove("active");
      }
    });
  });