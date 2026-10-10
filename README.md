# ContratoYa · App completa (registro, billetera, pagos reales con Stripe, PDF/Word)

## Qué incluye
- **Cuentas:** registro e inicio de sesión (contraseñas con bcrypt, sesión en cookie httpOnly firmada).
- **Billetera:** saldo por libro mayor (ledger) inmutable; recargas de $5/$10/$20/$50 con Stripe Checkout.
- **Pagos reales:** por documento con saldo o con tarjeta / Apple Pay / Google Pay (Stripe Checkout).
  El saldo y los documentos se acreditan **solo desde el webhook firmado de Stripe**, nunca desde el navegador.
      Los cobros se procesan en la cuenta Stripe asociada a `STRIPE_SECRET_KEY`; los depósitos a tu banco y su calendario se configuran en el Dashboard de esa misma cuenta.
- **Contratos:** 38 plantillas con datos de las partes, declaraciones, cláusulas, rescisión/penalización, anexos,
  inventario, recibos, firmas, folio y huella SHA-256. PDF y Word se generan en el servidor **solo si está pagado**.

## Puesta en marcha (local)
1. `npm install`
2. `cp .env.example .env` y completa `JWT_SECRET` (ver comando dentro del archivo).
3. Crea/verifica tu cuenta en https://stripe.com, configura sus datos bancarios y copia la clave **de prueba** (`sk_test_...`) a `STRIPE_SECRET_KEY`.
4. Webhook local obligatorio: instala la CLI de Stripe y ejecuta
   `stripe listen --forward-to localhost:3000/api/stripe/webhook`; copia el `whsec_...` a `STRIPE_WEBHOOK_SECRET`.
      La app no inicia Checkout si falta la clave o el secreto del webhook; usa ambos de la misma cuenta y modo (prueba o producción).
5. `npm start` → http://localhost:3000. Tarjeta de prueba: `4242 4242 4242 4242`, cualquier fecha futura y CVC.

## Salir a producción (checklist)
- [ ] Hosting con **HTTPS** y disco persistente (Render, Railway, Fly.io, un VPS) y `NODE_ENV=production`.
- [ ] Claves **live** de Stripe, y en Dashboard > Webhooks un endpoint `https://TU-DOMINIO/api/stripe/webhook`
      con los eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`.
- [ ] Activa Apple Pay / Google Pay en Stripe (Settings > Payment methods) y verifica tu dominio.
- [ ] Respaldos diarios de `contratoya.db` (o migra a PostgreSQL si esperas mucho volumen).
- [ ] Sustituye `public/terminos.html` y `public/privacidad.html` por textos redactados por un abogado.
- [ ] **Abogado:** revisa las plantillas y las cláusulas generales por jurisdicción (arrendamiento, laborales y
      pagarés tienen requisitos formales). Define tu régimen fiscal, impuestos y facturación (en México: CFDI/IVA/ISR).
- [ ] Recomendado: verificación de correo, recuperación de contraseña (requiere proveedor de email) y 2FA.
- [ ] Fase 2: firma electrónica integrada (Dropbox Sign API, DocuSign o Mifiel con constancia NOM-151).

## Comisiones de Stripe (importante para precios de micropagos)
Stripe cobra aprox. 2.9% + $0.30 USD por cobro con tarjeta (varía por país). En un documento de $1.50 eso es ~23%.
Por eso la **billetera** conviene: una recarga de $10 paga la comisión una vez y luego los documentos se cobran sin comisión.
Verifica tus tarifas reales en tu cuenta de Stripe.

## Seguridad implementada
Helmet (CSP estricta, HSTS en producción), cookies httpOnly + SameSite, cabecera anti-CSRF, límites de intentos en
login/registro, tiempos de login equiparados, validación de entradas, consultas parametrizadas, precios definidos
solo en el servidor, ledger idempotente (sin doble cobro ni doble recarga), verificación de propiedad de cada documento,
firma del webhook, descargas con `Cache-Control: no-store`.
