console.log("auth.jsが読み込まれました。");

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOMContentLoadedイベントが発生しました。");

  const hamburger = document.getElementById("hamburger");
  const mobileNav = document.getElementById("mobile-nav");
  const navLinks = document.querySelectorAll(".nav-link");

  if (!hamburger || !mobileNav) {
    console.error("ハンバーガーメニューまたはナビゲーションが見つかりません。");
    console.error("hamburger:", hamburger);
    console.error("mobileNav:", mobileNav);
    return;
  }

  console.log("ハンバーガーメニューとナビゲーションが見つかりました。");

  hamburger.addEventListener("click", () => {
    mobileNav.classList.toggle("active");
    console.log("ハンバーガーメニューをトグルしました。現在のクラス:", mobileNav.className);
  });

  navLinks.forEach(link => {
    link.addEventListener("click", () => {
      mobileNav.classList.remove("active");
      console.log("リンククリックでメニューを閉じました。");
    });
  });
});