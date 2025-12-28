// SYNAPSE Protocol - Main JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Initialize all functionality
    initNavigation();
    initAnimations();
    initMobileMenu();
    initCounters();
});

// Navigation scroll effect
function initNavigation() {
    const nav = document.querySelector('nav');
    
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            nav.classList.add('scrolled');
        } else {
            nav.classList.remove('scrolled');
        }
    });

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href !== '#') {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Close mobile menu if open
                    document.querySelector('.nav-links')?.classList.remove('active');
                }
            }
        });
    });
}

// Intersection Observer for fade-in animations
function initAnimations() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });

    document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

// Mobile menu toggle
function initMobileMenu() {
    const menuBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');

    if (menuBtn && navLinks) {
        menuBtn.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            menuBtn.classList.toggle('active');
        });
    }
}

// Animated counters for stats
function initCounters() {
    const stats = document.querySelectorAll('.stat-value[data-count]');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && !entry.target.classList.contains('counted')) {
                entry.target.classList.add('counted');
                animateCounter(entry.target);
            }
        });
    }, { threshold: 0.5 });

    stats.forEach(stat => observer.observe(stat));
}

function animateCounter(element) {
    const target = parseInt(element.dataset.count);
    const suffix = element.dataset.suffix || '';
    const duration = 2000;
    const start = 0;
    let startTime = null;

    function step(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = Math.min((timestamp - startTime) / duration, 1);
        const value = Math.floor(progress * (target - start) + start);
        element.textContent = value.toLocaleString() + suffix;
        
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    }

    window.requestAnimationFrame(step);
}

// Parallax effect for background elements
document.addEventListener('mousemove', (e) => {
    const particles = document.querySelectorAll('.particle');
    const x = e.clientX / window.innerWidth;
    const y = e.clientY / window.innerHeight;
    
    particles.forEach((particle, i) => {
        const speed = (i + 1) * 0.5;
        particle.style.transform = `translate(${x * speed * 20}px, ${y * speed * 20}px)`;
    });
});

// Language detection and redirect (for index.html only)
function detectLanguage() {
    const savedLang = localStorage.getItem('synapse-lang');
    if (savedLang) return savedLang;

    const browserLang = navigator.language.split('-')[0];
    const supportedLangs = ['en', 'pl', 'de', 'es', 'fr', 'zh', 'ja', 'ko', 'pt', 'ru', 'ar'];
    
    return supportedLangs.includes(browserLang) ? browserLang : 'en';
}

function setLanguage(lang) {
    localStorage.setItem('synapse-lang', lang);
}

// Export for use in pages
window.SynapseUtils = {
    detectLanguage,
    setLanguage,
    initCounters,
    initAnimations
};
