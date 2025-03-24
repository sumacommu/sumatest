
$(function(){

    var nowY = 0;
    $(window).scroll(function(){
        var elm = $('header');
        if (window.scrollY > 80 ){    
            if($(this).scrollTop() < nowY ){
                elm.removeClass('header-Out');
                elm.addClass('header-In');
            }
            else {
                elm.removeClass('header-In');
                elm.addClass('header-Out');
            }
            nowY = $(this).scrollTop();
        }
    });

    $(window).scroll(function () {
        var scrollelm = document.querySelectorAll('.main12');
        var fadein = function () {
          for (var i = 0; i < scrollelm.length; i++) {
            var triggerMargin = 100;
            if (window.innerHeight > scrollelm[i].getBoundingClientRect().top + triggerMargin) {
              scrollelm[i].classList.add('fadeIn-bottom');
            }
          }
        }
        window.addEventListener('scroll', fadein);
    });

});