// Navigation and Search Functionality

document.addEventListener('DOMContentLoaded', function() {
  // Back to top button
  const backToTop = document.getElementById('back-to-top');
  if (backToTop) {
    window.addEventListener('scroll', function() {
      if (window.pageYOffset > 300) {
        backToTop.classList.add('visible');
      } else {
        backToTop.classList.remove('visible');
      }
    });

    backToTop.addEventListener('click', function(e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // Highlight active sidebar link
  const currentPath = window.location.pathname;
  const sidebarLinks = document.querySelectorAll('.sidebar a');
  sidebarLinks.forEach(link => {
    if (link.getAttribute('href') === currentPath || 
        currentPath.includes(link.getAttribute('href'))) {
      link.classList.add('active');
    }
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (href !== '#' && href.length > 1) {
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    });
  });

  // Search functionality
  const searchBox = document.getElementById('search-box');
  if (searchBox) {
    searchBox.addEventListener('input', function(e) {
      const searchTerm = e.target.value.toLowerCase();
      const sidebarLinks = document.querySelectorAll('.sidebar li');
      
      sidebarLinks.forEach(li => {
        const text = li.textContent.toLowerCase();
        if (text.includes(searchTerm) || searchTerm === '') {
          li.style.display = '';
        } else {
          li.style.display = 'none';
        }
      });
    });
  }

  // Print functionality
  const printBtn = document.getElementById('print-btn');
  if (printBtn) {
    printBtn.addEventListener('click', function(e) {
      e.preventDefault();
      window.print();
    });
  }

  // Collapsible sections
  document.querySelectorAll('.collapsible').forEach(button => {
    button.addEventListener('click', function() {
      const content = this.nextElementSibling;
      const isExpanded = this.getAttribute('aria-expanded') === 'true';
      
      this.setAttribute('aria-expanded', !isExpanded);
      if (isExpanded) {
        content.style.display = 'none';
        this.classList.remove('expanded');
      } else {
        content.style.display = 'block';
        this.classList.add('expanded');
      }
    });
  });
});
