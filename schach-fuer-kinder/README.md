# Schach für Kinder – Website

Moderne One-Page-Website der Schachschule „Schach für Kinder" (Karlsruhe).

## Öffnen

Einfach `index.html` im Browser öffnen – keine Build-Tools nötig.
Alle Inhalte sind statisch (HTML/CSS/JS), die Schriften kommen von Google Fonts.

## Struktur

```
schach-fuer-kinder/
├── index.html        Alle Sektionen (Home, Über uns, Kurse, Spielecke,
│                     Schnupperstunde, Turnier, Warum Schach, Kontakt)
├── css/style.css     Designsystem: Elfenbein/Ebenholz/Signalrot + Brett-Holztöne,
│                     Archivo Black · Caveat · Nunito
├── js/main.js        Interaktion: Navigation, Scrollspy, Reveal-Animationen,
│                     Zähler, Turnier-Countdown, Figuren-Trainer, Springer-Jagd,
│                     Lightbox, Formular-Demo
└── images/           Logo und Fotos
```

## Interaktive Features

- **Figuren-Trainer**: Figur wählen, legale Züge sehen und per Klick ziehen
  (inkl. Bauernumwandlung auf der Grundreihe)
- **Springer-Jagd**: Mini-Spiel – mit Springerzügen 3 Sterne sammeln,
  Zugzähler, Rekord (localStorage) und Konfetti
- **Turnier-Countdown**: zählt live bis zum Termin (`TURNIER_DATUM` in
  `js/main.js` anpassen); nach Ablauf erscheint ein Hinweistext
- Scrollspy-Navigation, Mobile-Overlay-Menü, Scroll-Reveal, animierte
  Zahlen, Bild-Lightbox, „Mehr lesen"-Umschalter, Kontaktformular (Demo,
  versendet noch nichts)

## Hinweis

Das Kontaktformular ist bewusst als Vorschau ohne Versand gebaut – für den
Livegang einen Formulardienst oder ein Backend anbinden.
