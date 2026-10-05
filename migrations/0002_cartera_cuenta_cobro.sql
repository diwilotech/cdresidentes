-- Configuración de cartera y cuenta de cobro (Ajustes) y datos de pago por conjunto.
-- Solo agrega columnas: el código anterior sigue funcionando.

-- JSON: formato del PDF (media carta / carta original y copia / carta en serie), tasa de interés de mora,
-- cobro jurídico (% y días de mora), retroactivo, cuota extraordinaria, día de vencimiento y nota al pie.
ALTER TABLE businesses ADD COLUMN billing TEXT;

-- Cuenta bancaria, referencia de pago, enlace PSE… (cada conjunto tiene su NIT y su cuenta).
ALTER TABLE properties ADD COLUMN payment_info TEXT;
