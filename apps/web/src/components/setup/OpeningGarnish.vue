<script setup lang="ts">
/**
 * The opening plate around the New game compass (Decktank `Main.dc.html`, "Opening garnish"):
 * cross rulers, a bearing ring, the five colours on a pentagram and a few constellations turning
 * slowly round the middle. Drawn only on the opening "Where to?" screen; it fades as the menu
 * opens. Pure decoration, hidden from assistive technology. Colours are theme tokens, so the night
 * theme draws it in light ink.
 */
</script>

<template>
  <div class="garnish" aria-hidden="true">
    <div class="fade">
      <svg viewBox="-380 -380 760 760" class="layer">
        <path
          d="M-380 0L-250 0M250 0L380 0M0 -380L0 -250M0 250L0 380"
          stroke-width="0.6"
          class="sf"
        />
        <path
          d="M-250 -6L-250 6M-6 -250L6 -250M-258 -3L-258 3M-3 -258L3 -258M-266 -3L-266 3M-3 -266L3 -266M-274 -3L-274 3M-3 -274L3 -274M-282 -3L-282 3M-3 -282L3 -282M-290 -6L-290 6M-6 -290L6 -290M-298 -3L-298 3M-3 -298L3 -298M-306 -3L-306 3M-3 -306L3 -306M-314 -3L-314 3M-3 -314L3 -314M-322 -3L-322 3M-3 -322L3 -322M-330 -6L-330 6M-6 -330L6 -330M-338 -3L-338 3M-3 -338L3 -338M-346 -3L-346 3M-3 -346L3 -346M-354 -3L-354 3M-3 -354L3 -354M-362 -3L-362 3M-3 -362L3 -362M-370 -6L-370 6M-6 -370L6 -370M250 -6L250 6M-6 250L6 250M258 -3L258 3M-3 258L3 258M266 -3L266 3M-3 266L3 266M274 -3L274 3M-3 274L3 274M282 -3L282 3M-3 282L3 282M290 -6L290 6M-6 290L6 290M298 -3L298 3M-3 298L3 298M306 -3L306 3M-3 306L3 306M314 -3L314 3M-3 314L3 314M322 -3L322 3M-3 322L3 322M330 -6L330 6M-6 330L6 330M338 -3L338 3M-3 338L3 338M346 -3L346 3M-3 346L3 346M354 -3L354 3M-3 354L3 354M362 -3L362 3M-3 362L3 362M370 -6L370 6M-6 370L6 370"
          stroke-width="0.6"
          class="sf"
        />
        <circle r="318" fill="none" stroke-width="0.6" stroke-dasharray="6 6" class="sr" />
      </svg>
      <!-- the sky: constellations and loose stars turning slowly round the middle -->
      <svg viewBox="-380 -380 760 760" class="layer spin s420">
        <path
          d="M-330 -250L-300 -205L-262 -238L-228 -292 M318 -262L282 -300L250 -250 M-320 250L-276 300L-240 262 M330 240L296 300L262 268 M50 -328L65 -339L84 -334L112 -318L131 -324 M252 -174L280 -156L297 -134L323 -143L323 -164L326 -184 M361 112L349 97L339 78L310 79L282 76 M201 322L188 303L167 297L158 281L135 269 M-130 317L-104 332L-81 321 M-282 131L-286 157L-302 167L-298 189L-306 207 M-346 -98L-343 -69L-318 -66L-304 -80L-318 -107L-340 -109 M-189 -302L-173 -287L-149 -293 M57 433L38 430L25 399L27 369L24 337 M-358 15L-373 36L-381 55L-405 52L-421 74L-409 98 M-60 -387L-38 -396L-5 -396"
          fill="none"
          stroke-width="0.6"
          class="sr"
        />
        <g class="fi">
          <circle cx="-330" cy="-250" r="1.7" />
          <circle cx="-300" cy="-205" r="0.9" />
          <circle cx="-262" cy="-238" r="1.3" />
          <circle cx="-228" cy="-292" r="1.3" />
          <circle cx="318" cy="-262" r="1.7" />
          <circle cx="282" cy="-300" r="1.3" />
          <circle cx="250" cy="-250" r="1.3" />
          <circle cx="-320" cy="250" r="1.7" />
          <circle cx="-276" cy="300" r="1.2" />
          <circle cx="-240" cy="262" r="0.9" />
          <circle cx="330" cy="240" r="1.7" />
          <circle cx="296" cy="300" r="1" />
          <circle cx="262" cy="268" r="0.9" />
          <circle cx="50" cy="-328" r="1.7" />
          <circle cx="65" cy="-339" r="1.2" />
          <circle cx="84" cy="-334" r="1.2" />
          <circle cx="112" cy="-318" r="1.3" />
          <circle cx="131" cy="-324" r="1" />
          <circle cx="252" cy="-174" r="1.7" />
          <circle cx="280" cy="-156" r="1.6" />
          <circle cx="297" cy="-134" r="0.9" />
          <circle cx="323" cy="-143" r="1" />
          <circle cx="323" cy="-164" r="1.6" />
          <circle cx="326" cy="-184" r="1.2" />
          <circle cx="361" cy="112" r="1.7" />
          <circle cx="349" cy="97" r="1" />
          <circle cx="339" cy="78" r="1.6" />
          <circle cx="310" cy="79" r="0.9" />
          <circle cx="282" cy="76" r="1.6" />
          <circle cx="201" cy="322" r="1.7" />
          <circle cx="188" cy="303" r="1.2" />
          <circle cx="167" cy="297" r="0.9" />
          <circle cx="158" cy="281" r="1.2" />
          <circle cx="135" cy="269" r="1.6" />
          <circle cx="-130" cy="317" r="1.7" />
          <circle cx="-104" cy="332" r="1.2" />
          <circle cx="-81" cy="321" r="1" />
          <circle cx="-282" cy="131" r="1.7" />
          <circle cx="-286" cy="157" r="1.2" />
          <circle cx="-302" cy="167" r="1" />
          <circle cx="-298" cy="189" r="1.6" />
          <circle cx="-306" cy="207" r="1.6" />
          <circle cx="-346" cy="-98" r="1.7" />
          <circle cx="-343" cy="-69" r="1.6" />
          <circle cx="-318" cy="-66" r="1.2" />
          <circle cx="-304" cy="-80" r="1" />
          <circle cx="-318" cy="-107" r="1.6" />
          <circle cx="-340" cy="-109" r="1" />
          <circle cx="-189" cy="-302" r="1.7" />
          <circle cx="-173" cy="-287" r="1" />
          <circle cx="-149" cy="-293" r="1.3" />
          <circle cx="57" cy="433" r="1.7" />
          <circle cx="38" cy="430" r="1.2" />
          <circle cx="25" cy="399" r="0.9" />
          <circle cx="27" cy="369" r="0.9" />
          <circle cx="24" cy="337" r="1.2" />
          <circle cx="-358" cy="15" r="1.7" />
          <circle cx="-373" cy="36" r="1.3" />
          <circle cx="-381" cy="55" r="1.2" />
          <circle cx="-405" cy="52" r="1" />
          <circle cx="-421" cy="74" r="1.6" />
          <circle cx="-409" cy="98" r="1.2" />
          <circle cx="-60" cy="-387" r="1.7" />
          <circle cx="-38" cy="-396" r="1.3" />
          <circle cx="-5" cy="-396" r="1.2" />
        </g>
        <g class="fm">
          <circle cx="-93" cy="-321" r="0.6" />
          <circle cx="207" cy="-277" r="0.8" />
          <circle cx="350" cy="-103" r="0.9" />
          <circle cx="-293" cy="-187" r="0.9" />
          <circle cx="305" cy="204" r="0.9" />
          <circle cx="230" cy="-246" r="0.9" />
          <circle cx="-347" cy="0" r="0.6" />
          <circle cx="148" cy="335" r="0.6" />
          <circle cx="-386" cy="-128" r="0.8" />
          <circle cx="87" cy="369" r="0.6" />
          <circle cx="-307" cy="49" r="0.6" />
          <circle cx="62" cy="-356" r="0.8" />
          <circle cx="-288" cy="-107" r="0.9" />
          <circle cx="-46" cy="-366" r="0.8" />
          <circle cx="295" cy="-198" r="0.6" />
          <circle cx="36" cy="-405" r="0.9" />
          <circle cx="229" cy="-303" r="0.6" />
          <circle cx="159" cy="361" r="0.6" />
          <circle cx="55" cy="-311" r="0.9" />
          <circle cx="360" cy="-21" r="0.8" />
          <circle cx="-107" cy="375" r="0.6" />
          <circle cx="-178" cy="-281" r="0.8" />
          <circle cx="-331" cy="203" r="0.9" />
          <circle cx="191" cy="351" r="0.9" />
          <circle cx="226" cy="-210" r="0.9" />
          <circle cx="40" cy="-340" r="0.6" />
          <circle cx="-345" cy="-140" r="0.9" />
          <circle cx="340" cy="-188" r="0.9" />
          <circle cx="355" cy="330" r="0.9" />
          <circle cx="-180" cy="-340" r="0.9" />
          <circle cx="170" cy="345" r="0.9" />
        </g>
      </svg>
      <svg viewBox="-380 -380 760 760" class="layer spin s240">
        <circle r="214" fill="none" stroke-width="0.6" class="sm" />
        <circle r="246" fill="none" stroke-width="0.6" class="sm" />
        <path
          d="M0.0 -214.0L0.0 -226.0M7.5 -213.9L7.6 -217.9M14.9 -213.5L15.2 -217.5M22.4 -212.8L22.8 -216.8M29.8 -211.9L30.3 -215.9M37.2 -210.7L38.5 -218.6M44.5 -209.3L45.3 -213.2M51.8 -207.6L52.7 -211.5M59.0 -205.7L60.1 -209.6M66.1 -203.5L67.4 -207.3M73.2 -201.1L75.9 -208.6M80.2 -198.4L81.7 -202.1M87.0 -195.5L88.7 -199.2M93.8 -192.3L95.6 -195.9M100.5 -189.0L102.3 -192.5M107.0 -185.3L113.0 -195.7M113.4 -181.5L115.5 -184.9M119.7 -177.4L121.9 -180.7M125.8 -173.1L128.1 -176.4M131.8 -168.6L134.2 -171.8M137.6 -163.9L142.7 -170.1M143.2 -159.0L145.9 -162.0M148.7 -153.9L151.4 -156.8M153.9 -148.7L156.8 -151.4M159.0 -143.2L162.0 -145.9M163.9 -137.6L170.1 -142.7M168.6 -131.8L171.8 -134.2M173.1 -125.8L176.4 -128.1M177.4 -119.7L180.7 -121.9M181.5 -113.4L184.9 -115.5M185.3 -107.0L195.7 -113.0M189.0 -100.5L192.5 -102.3M192.3 -93.8L195.9 -95.6M195.5 -87.0L199.2 -88.7M198.4 -80.2L202.1 -81.7M201.1 -73.2L208.6 -75.9M203.5 -66.1L207.3 -67.4M205.7 -59.0L209.6 -60.1M207.6 -51.8L211.5 -52.7M209.3 -44.5L213.2 -45.3M210.7 -37.2L218.6 -38.5M211.9 -29.8L215.9 -30.3M212.8 -22.4L216.8 -22.8M213.5 -14.9L217.5 -15.2M213.9 -7.5L217.9 -7.6M214.0 0.0L226.0 0.0M213.9 7.5L217.9 7.6M213.5 14.9L217.5 15.2M212.8 22.4L216.8 22.8M211.9 29.8L215.9 30.3M210.7 37.2L218.6 38.5M209.3 44.5L213.2 45.3M207.6 51.8L211.5 52.7M205.7 59.0L209.6 60.1M203.5 66.1L207.3 67.4M201.1 73.2L208.6 75.9M198.4 80.2L202.1 81.7M195.5 87.0L199.2 88.7M192.3 93.8L195.9 95.6M189.0 100.5L192.5 102.3M185.3 107.0L195.7 113.0M181.5 113.4L184.9 115.5M177.4 119.7L180.7 121.9M173.1 125.8L176.4 128.1M168.6 131.8L171.8 134.2M163.9 137.6L170.1 142.7M159.0 143.2L162.0 145.9M153.9 148.7L156.8 151.4M148.7 153.9L151.4 156.8M143.2 159.0L145.9 162.0M137.6 163.9L142.7 170.1M131.8 168.6L134.2 171.8M125.8 173.1L128.1 176.4M119.7 177.4L121.9 180.7M113.4 181.5L115.5 184.9M107.0 185.3L113.0 195.7M100.5 189.0L102.3 192.5M93.8 192.3L95.6 195.9M87.0 195.5L88.7 199.2M80.2 198.4L81.7 202.1M73.2 201.1L75.9 208.6M66.1 203.5L67.4 207.3M59.0 205.7L60.1 209.6M51.8 207.6L52.7 211.5M44.5 209.3L45.3 213.2M37.2 210.7L38.5 218.6M29.8 211.9L30.3 215.9M22.4 212.8L22.8 216.8M14.9 213.5L15.2 217.5M7.5 213.9L7.6 217.9M0.0 214.0L0.0 226.0M-7.5 213.9L-7.6 217.9M-14.9 213.5L-15.2 217.5M-22.4 212.8L-22.8 216.8M-29.8 211.9L-30.3 215.9M-37.2 210.7L-38.5 218.6M-44.5 209.3L-45.3 213.2M-51.8 207.6L-52.7 211.5M-59.0 205.7L-60.1 209.6M-66.1 203.5L-67.4 207.3M-73.2 201.1L-75.9 208.6M-80.2 198.4L-81.7 202.1M-87.0 195.5L-88.7 199.2M-93.8 192.3L-95.6 195.9M-100.5 189.0L-102.3 192.5M-107.0 185.3L-113.0 195.7M-113.4 181.5L-115.5 184.9M-119.7 177.4L-121.9 180.7M-125.8 173.1L-128.1 176.4M-131.8 168.6L-134.2 171.8M-137.6 163.9L-142.7 170.1M-143.2 159.0L-145.9 162.0M-148.7 153.9L-151.4 156.8M-153.9 148.7L-156.8 151.4M-159.0 143.2L-162.0 145.9M-163.9 137.6L-170.1 142.7M-168.6 131.8L-171.8 134.2M-173.1 125.8L-176.4 128.1M-177.4 119.7L-180.7 121.9M-181.5 113.4L-184.9 115.5M-185.3 107.0L-195.7 113.0M-189.0 100.5L-192.5 102.3M-192.3 93.8L-195.9 95.6M-195.5 87.0L-199.2 88.7M-198.4 80.2L-202.1 81.7M-201.1 73.2L-208.6 75.9M-203.5 66.1L-207.3 67.4M-205.7 59.0L-209.6 60.1M-207.6 51.8L-211.5 52.7M-209.3 44.5L-213.2 45.3M-210.7 37.2L-218.6 38.5M-211.9 29.8L-215.9 30.3M-212.8 22.4L-216.8 22.8M-213.5 14.9L-217.5 15.2M-213.9 7.5L-217.9 7.6M-214.0 0.0L-226.0 0.0M-213.9 -7.5L-217.9 -7.6M-213.5 -14.9L-217.5 -15.2M-212.8 -22.4L-216.8 -22.8M-211.9 -29.8L-215.9 -30.3M-210.7 -37.2L-218.6 -38.5M-209.3 -44.5L-213.2 -45.3M-207.6 -51.8L-211.5 -52.7M-205.7 -59.0L-209.6 -60.1M-203.5 -66.1L-207.3 -67.4M-201.1 -73.2L-208.6 -75.9M-198.4 -80.2L-202.1 -81.7M-195.5 -87.0L-199.2 -88.7M-192.3 -93.8L-195.9 -95.6M-189.0 -100.5L-192.5 -102.3M-185.3 -107.0L-195.7 -113.0M-181.5 -113.4L-184.9 -115.5M-177.4 -119.7L-180.7 -121.9M-173.1 -125.8L-176.4 -128.1M-168.6 -131.8L-171.8 -134.2M-163.9 -137.6L-170.1 -142.7M-159.0 -143.2L-162.0 -145.9M-153.9 -148.7L-156.8 -151.4M-148.7 -153.9L-151.4 -156.8M-143.2 -159.0L-145.9 -162.0M-137.6 -163.9L-142.7 -170.1M-131.8 -168.6L-134.2 -171.8M-125.8 -173.1L-128.1 -176.4M-119.7 -177.4L-121.9 -180.7M-113.4 -181.5L-115.5 -184.9M-107.0 -185.3L-113.0 -195.7M-100.5 -189.0L-102.3 -192.5M-93.8 -192.3L-95.6 -195.9M-87.0 -195.5L-88.7 -199.2M-80.2 -198.4L-81.7 -202.1M-73.2 -201.1L-75.9 -208.6M-66.1 -203.5L-67.4 -207.3M-59.0 -205.7L-60.1 -209.6M-51.8 -207.6L-52.7 -211.5M-44.5 -209.3L-45.3 -213.2M-37.2 -210.7L-38.5 -218.6M-29.8 -211.9L-30.3 -215.9M-22.4 -212.8L-22.8 -216.8M-14.9 -213.5L-15.2 -217.5M-7.5 -213.9L-7.6 -217.9"
          stroke-width="0.6"
          class="sm"
        />
        <g style="font-family: var(--font-body); font-size: 7px; letter-spacing: 0.08em" class="fm">
          <text x="0" y="-238" transform="rotate(0)" text-anchor="middle">000</text>
          <text x="0" y="-238" transform="rotate(30)" text-anchor="middle">030</text>
          <text x="0" y="-238" transform="rotate(60)" text-anchor="middle">060</text>
          <text x="0" y="-238" transform="rotate(90)" text-anchor="middle">090</text>
          <text x="0" y="-238" transform="rotate(120)" text-anchor="middle">120</text>
          <text x="0" y="-238" transform="rotate(150)" text-anchor="middle">150</text>
          <text x="0" y="-238" transform="rotate(180)" text-anchor="middle">180</text>
          <text x="0" y="-238" transform="rotate(210)" text-anchor="middle">210</text>
          <text x="0" y="-238" transform="rotate(240)" text-anchor="middle">240</text>
          <text x="0" y="-238" transform="rotate(270)" text-anchor="middle">270</text>
          <text x="0" y="-238" transform="rotate(300)" text-anchor="middle">300</text>
          <text x="0" y="-238" transform="rotate(330)" text-anchor="middle">330</text>
        </g>
      </svg>
      <svg viewBox="-380 -380 760 760" class="layer spin back s360">
        <circle r="272" fill="none" stroke-width="0.6" stroke-dasharray="1 5" class="sf" />
        <path
          d="M159.9 -220.1L0.0 272.0L-159.9 -220.1L258.7 84.1L-258.7 84.1L159.9 -220.1"
          fill="none"
          stroke-width="0.6"
          class="sr"
        />
        <circle cx="159.9" cy="-220.1" r="9" stroke-width="0.8" class="si pw" />
        <text
          x="159.9"
          y="-216.5"
          text-anchor="middle"
          transform="rotate(-36 159.9 -220.1)"
          style="font-family: var(--font-display); font-size: 10px"
        >
          W
        </text>
        <circle cx="258.7" cy="84.1" r="9" stroke-width="0.8" class="si pu" />
        <text
          x="258.7"
          y="87.69999999999999"
          text-anchor="middle"
          transform="rotate(-108 258.7 84.1)"
          style="font-family: 'Bodoni Moda', Didot, serif; font-size: 10px"
        >
          U
        </text>
        <circle cx="0.0" cy="272.0" r="9" stroke-width="0.8" class="si pb" />
        <text
          x="0.0"
          y="275.6"
          text-anchor="middle"
          transform="rotate(-180 0.0 272.0)"
          style="font-family: 'Bodoni Moda', Didot, serif; font-size: 10px"
          class="fp"
        >
          B
        </text>
        <circle cx="-258.7" cy="84.1" r="9" stroke-width="0.8" class="si pr" />
        <text
          x="-258.7"
          y="87.69999999999999"
          text-anchor="middle"
          transform="rotate(-252 -258.7 84.1)"
          style="font-family: 'Bodoni Moda', Didot, serif; font-size: 10px"
        >
          R
        </text>
        <circle cx="-159.9" cy="-220.1" r="9" stroke-width="0.8" class="si pg" />
        <text
          x="-159.9"
          y="-216.5"
          text-anchor="middle"
          transform="rotate(-324 -159.9 -220.1)"
          style="font-family: 'Bodoni Moda', Didot, serif; font-size: 10px"
        >
          G
        </text>
      </svg>
      <svg viewBox="-380 -380 760 760" class="layer spin s70">
        <circle cx="0" cy="-318" r="4" class="fw" />
        <circle cx="0" cy="-318" r="8" fill="none" stroke-width="0.6" class="sw" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.garnish {
  position: absolute;
  inset: -46%;
  pointer-events: none;
}
.fade {
  position: absolute;
  inset: 0;
  animation: garnishFade 1.4s var(--ease) 0.9s both;
}
.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.spin {
  will-change: transform;
  animation: garnishDrift 420s linear infinite;
}
.spin.s240 {
  animation-duration: 240s;
}
.spin.s360 {
  animation-duration: 360s;
  animation-direction: reverse;
}
.spin.s70 {
  animation-duration: 70s;
}
.sf {
  stroke: var(--faint, #8f8c88);
}
.sr {
  stroke: var(--rule);
}
.sm {
  stroke: color-mix(in srgb, var(--muted) 85%, var(--ink));
}
.si {
  stroke: var(--ink);
}
.sw {
  stroke: var(--warm);
}
.fi {
  fill: var(--ink);
}
.fm {
  fill: var(--muted);
}
.fw {
  fill: var(--warm);
}
.fp {
  fill: var(--paper);
}
.pw {
  fill: var(--mana-w);
}
.pu {
  fill: var(--mana-u);
}
.pb {
  fill: var(--mana-b);
}
.pr {
  fill: var(--mana-r);
}
.pg {
  fill: var(--mana-g);
}
@keyframes garnishFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes garnishDrift {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
:global(.reduced-motion) .spin {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  .spin,
  .fade {
    animation: none;
  }
}
</style>
