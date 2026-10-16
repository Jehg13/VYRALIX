# VYRALIX

Aplicación local para organizar contenido editorial. Esta primera fase incluye un frontend React, una API REST y persistencia SQLite. La cola procesa **pruebas locales**, no publica en redes sociales.

## Requisitos

- Windows 10/11
- Node.js 22 LTS (incluye npm)

## Instalación y arranque

Desde PowerShell, abre la carpeta `VYRALIX` y ejecuta:

```powershell
npm.cmd install
npm.cmd run dev
```

Abre <http://localhost:5173>. El backend escucha únicamente en `127.0.0.1:3001`. Para detener ambos servicios, usa `Ctrl+C` en la terminal.
Si necesitas personalizar la API, copia `.env.example` a `.env` antes de iniciarla; la API carga ese archivo de forma opcional con la API nativa de Node 22.

Para validar el proyecto:

```powershell
npm.cmd test
npm.cmd run build
```

El modo de producción del backend se inicia con `npm.cmd start`. El frontend compilado se genera en `apps/web/dist`; el servidor de desarrollo Vite sirve la interfaz durante esta fase.

## Persistencia y respaldo

La base de datos se crea automáticamente en `data/vyralix.sqlite`. Puede cambiarse mediante `VYRALIX_DB_PATH` (ruta absoluta). El esquema inicial vive en `apps/api/migrations/001_initial.sql`.

En la aplicación, abre **Configuración → Crear respaldo de SQLite**. El archivo se guarda junto a la base de datos, dentro de `backups/`. Para restaurarlo:

1. Detén VYRALIX y confirma que el backend ya terminó.
2. Conserva una copia de la base actual.
3. Copia el archivo elegido desde `backups/` a la ruta `vyralix.sqlite` configurada.
4. Inicia la aplicación y comprueba que aparecen tus datos.

## Arquitectura

- `apps/web`: React, TypeScript, Vite, React Router y Lucide. Llama exclusivamente a la API local.
- `apps/api`: Express, validación Zod, registro JSON y SQLite (`better-sqlite3`).
- `apps/api/migrations`: esquema versionado.
- `data/`: base local, ignorada por Git.
- REST versionada bajo `/api/v1`.

La API no escucha en interfaces de red externas. CORS permite el origen local del frontend (`127.0.0.1` o `localhost`, configurable con `WEB_ORIGIN`). No se guardan credenciales externas. La zona horaria de calendario utiliza la hora local del navegador; todavía no hay un ajuste persistente de zona horaria.

## Endpoints iniciales

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/health` | Estado del backend |
| GET, POST | `/api/v1/posts` | Buscar y crear contenido |
| GET, PUT, DELETE | `/api/v1/posts/:id` | Consultar, editar y eliminar contenido |
| PATCH | `/api/v1/posts/:id/status` | Transición de estado validada |
| GET | `/api/v1/calendar?from=...&to=...` | Contenido con fecha objetivo en el rango |
| GET, POST | `/api/v1/jobs` | Consultar trabajos y encolar prueba local |
| GET | `/api/v1/dashboard` | Resumen agregado desde SQLite |
| POST | `/api/v1/backup` | Crear copia de seguridad SQLite |

Estados editoriales y transiciones están validados en el backend. El worker persistente solo acepta trabajos `local_test`; cada resultado indica que no se efectuó una publicación externa. Los trabajos locales interrumpidos se recuperan al reiniciar. La clave de idempotencia evita encolar de nuevo un trabajo ya procesado para la misma publicación.

## Motor de generación con IA

La ruta **Generador IA** permite generar de 1 a 4 variantes de ideas y guiones estructurados en español, previsualizarlos, editarlos, regenerarlos y guardarlos como borradores. Las generaciones, errores, intentos y tokens informados por el proveedor quedan en SQLite. El guardado de variantes es idempotente y nunca publica en TikTok. La comprobación de disponibilidad es explícita: no se afirma disponibilidad hasta consultar al endpoint de modelos del proveedor. Sin credenciales/modelo, la app sigue funcionando y la generación indica qué variables faltan.

No se envía texto a un proveedor hasta iniciar una generación. Gemini y Groq son servicios alojados: tarifas, cuotas gratuitas y tratamiento de datos dependen del plan y la cuenta; VYRALIX no puede verificar tu cuota ni costo. La primera prioridad configurada puede atender una solicitud automática si tiene credenciales y modelo. Para evitar que un error provoque un cambio automático a otro servicio alojado que pueda cobrar, el fallback secundario de Gemini/Groq está desactivado hasta configurar `GEMINI_AUTO_FALLBACK=true` o `GROQ_AUTO_FALLBACK=true`. Ollama solo acepta una URL HTTP de loopback. Costos se registran como desconocidos salvo que haya una fuente fiable; los contadores de tokens se muestran solo cuando el proveedor los devuelve.

### Configuración

1. Copia `.env.example` a `.env` en la raíz.
2. Para Gemini, crea una clave en [Google AI Studio](https://aistudio.google.com/app/apikey) y guarda `GEMINI_API_KEY`. Define `GEMINI_MODEL` con un identificador de texto que aparezca en la comprobación de modelos de VYRALIX. Catálogo oficial: [Gemini API models](https://ai.google.dev/gemini-api/docs/models).
3. Para Groq, crea una clave en [Groq Console](https://console.groq.com/keys), configura `GROQ_API_KEY` y el identificador de un modelo activo que anuncie la API. Catálogo y modelos activos: [Groq models](https://console.groq.com/docs/models). Comprueba los límites y condiciones de facturación de tu cuenta.
4. Para Ollama, instala [Ollama para Windows](https://ollama.com/download), descarga un modelo compatible con generación estructurada según su documentación y establece su nombre exacto en `OLLAMA_MODEL`. Mantén el servicio enlazado a `127.0.0.1`; VYRALIX rechaza URLs remotas. API: [Ollama API](https://docs.ollama.com/api).
5. Reinicia la API (`Ctrl+C` y `npm.cmd run dev`) después de cambiar `.env`. Usa **Configuración → Proveedores IA → Comprobar disponibilidad** para validar credenciales, modelos y mostrar IDs de modelos que el proveedor anuncia.

Las variables de fallback y prioridad no muestran claves en el navegador. Las llamadas alojadas envían el texto del formulario a Google o Groq; revisa sus términos de privacidad, retención y uso de datos aplicables al plan antes de enviar contenido sensible. La disponibilidad de niveles gratuitos cambia por proveedor, región y cuenta y no se garantiza. VYRALIX no activa planes ni compra créditos.

## Endpoints de IA

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/ai/providers` | Configuración no sensible, prioridad y última disponibilidad comprobada |
| POST | `/api/v1/ai/providers/check` | Comprobar modelos configurados (límite local) |
| PUT | `/api/v1/ai/providers/priority` | Guardar orden de prioridad |
| POST | `/api/v1/ai/generations` | Generar con `Idempotency-Key` UUID y entrada validada |
| GET | `/api/v1/ai/generations?limit=20` | Historial persistente |
| GET | `/api/v1/ai/generations/:id` | Consultar generación, variantes e intentos |
| POST | `/api/v1/ai/generations/:id/save` | Guardar/editar una variante como borrador idempotente |
| POST | `/api/v1/ai/generations/:id/discard` | Descartar una variante no guardada |

El router distingue cuota/429 (`Retry-After` preservado y sin reintento prematuro del mismo proveedor), errores temporales (un reintento acotado con espera creciente), conectividad, timeout, autenticación, modelo y formato inválidos. Si una respuesta no cumple el esquema, intenta el siguiente proveedor elegible. Ninguna respuesta del modelo se persiste como borrador hasta pasar validación. La cuota exacta y el costo permanecen desconocidos si la API no los expone.

## Media Studio local

Media Studio crea proyectos audiovisuales desde un borrador existente (sin cambiar ni publicar ese borrador), genera un plan local editable de escenas, importa imágenes/clips/grabaciones a `data/media/assets`, y guarda escenas, recursos y trabajos en SQLite. Los archivos multimedia grandes no se guardan como BLOB. Se admiten PNG/JPEG/WebP, MP4/MOV/WebM y MP3/WAV/M4A/OGG; el máximo por archivo es 250 MiB por defecto (configurable, hasta 1 GiB). Las importaciones se identifican por SHA-256 para evitar duplicados idénticos. Los archivos guardados dentro de proyectos no se pueden borrar hasta reemplazar sus asignaciones.

El renderizador usa FFmpeg y FFprobe locales. Consulta **Media Studio → Diagnóstico** para ver versiones y capacidades detectadas. FFmpeg no es requisito para que la app siga funcionando. En Windows puedes instalar una distribución confiable (por ejemplo, `winget install Gyan.FFmpeg` si winget está disponible) o definir `FFMPEG_PATH` y `FFPROBE_PATH` en `.env`; después reinicia la API. VYRALIX no descarga ni ejecuta instaladores. Si usas rutas personalizadas, apunta a los ejecutables instalados de FFmpeg y FFprobe.

Para tu primer video:

1. Inicia `npm.cmd run dev` y abre **Media Studio**.
2. Comprueba que FFmpeg y FFprobe están disponibles en el diagnóstico.
3. Importa recursos propios o con licencia que permita su uso; la procedencia/licencia se declara, pero VYRALIX no la verifica.
4. Selecciona un borrador, crea el proyecto, revisa/edita escenas y asigna recursos.
5. Configura duración, 720×1280 o 1080×1920, FPS y calidad; inicia el renderizado.
6. Sigue la cola: el progreso porcentual solo aparece cuando FFmpeg informa el tiempo procesado. FFprobe debe validar contenedor, duración y resolución antes de registrar una exportación en `data/media/exports`.

Las escenas sin imágenes o clips usan un fondo abstracto local y subtítulos; no se generan imágenes/videos realistas. Los subtítulos SRT se estiman por duración de escena y no están alineados palabra por palabra. El primer render de guiones ya divididos muy largos puede requerir ajuste manual de escena. El render se ejecuta por CPU; el valor inicial es una resolución ligera de 720×1280, 30 FPS, con un trabajo simultáneo.

No se implementan descargas de redes, generación de imágenes/video en la nube ni publicación externa. Comprueba las licencias del ejecutable FFmpeg y de los recursos multimedia que incorpores. No expongas la API local fuera de loopback sin autenticación y protecciones adicionales.

### Planificación audiovisual con IA

En **Media Studio**, elige un proyecto y configura duración, cantidad de escenas, plataforma, estilo, tono, ritmo, público, modo de voz e idioma. Pulsa **Generar propuesta** para pedir un plan estructurado a un proveedor configurado. Abrir Media Studio y editar proyectos no hace llamadas a proveedores. La propuesta se puede editar, regenerar completa o escena por escena, o cancelar; no reemplaza las escenas existentes hasta que pulses **Aprobar y guardar plan**. La aprobación reemplaza las escenas del proyecto en una transacción, pero no borra recursos importados. Si eliges conservar recursos, revisa cada asignación después de aplicar el plan.

Usa las claves y los identificadores de modelo descritos en **Configuración** del Generador IA: colócalos en `.env` en la raíz de `VYRALIX`, nunca en el frontend ni en el repositorio, y reinicia la API. El selector permite escoger explícitamente Gemini, Groq u Ollama, o usar `auto` según la prioridad configurada. Gemini y Groq son servicios alojados y pueden generar cargos; `auto` también podría elegirlos. Ollama es local y debe usar loopback. No se envía el guion a ningún proveedor hasta solicitar la generación o regeneración. Revisa privacidad, tarifas y límites antes de enviar contenido.

La IA solo propone texto e instrucciones audiovisuales: no crea imágenes, clips ni voz. Las escenas de un plan IA que aún no tienen material visual propio quedan marcadas como pendientes y no se pueden renderizar hasta asignarles una imagen o un clip de la biblioteca. El render no inventa archivos ni marca una escena pendiente como lista. Los planes creados con el planificador local conservan el comportamiento de composición abstracta existente.

### Voz y narración local

La sección **Voz y narración** de cada proyecto usa **Windows SAPI / System.Speech** y las voces de escritorio instaladas en Windows. No usa las claves de Gemini o Groq, no transmite el texto a internet y no consume créditos. No requiere instalar paquetes npm ni agregar variables a `.env`. El diagnóstico muestra las voces locales disponibles y sus idiomas; instala una voz de Windows desde la configuración del sistema si no aparece una voz adecuada.

Guarda primero el texto de narración de la escena. Después selecciona la voz/idioma y la velocidad/volumen permitidos por SAPI, y genera una escena o todas las narraciones guardadas. Cada solicitud se ejecuta como trabajo local cancelable; el archivo solo se activa después de que FFprobe confirme un WAV reproducible y su duración real. La regeneración conserva la última versión válida si falla. Cambiar el texto marca la versión anterior como desactualizada; regenera la voz antes de exportar. La reproducción de vista previa usa el WAV de la escena. **Desvincular audio** lo retira de la mezcla futura, pero conserva el archivo y su historial.

Los WAV y sus metadatos se guardan en `data/media/voices` y SQLite. El render alinea los fragmentos con el orden de las escenas y completa con silencio las escenas sin narración. Si un fragmento dura más que su escena, la exportación se bloquea con una advertencia: VYRALIX no acelera ni recorta la voz automáticamente. Los audios integrados de clips importados no se mezclan, evitando duplicarlos; la grabación global del proyecto y las voces generadas por escena no se combinan entre sí. Para usar una grabación importada, desvincula primero las voces por escena. La pista musical independiente continúa siendo opcional.

El motor ofrece una voz por escena. Los diálogos de varios personajes no se separan ni se asignan a voces distintas: si una escena solo tiene diálogo, debe editarse como narración o grabarse e importarse manualmente. No hay alineación palabra por palabra; los subtítulos siguen siendo aproximaciones por escena.

### Endpoints multimedia

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/v1/media/diagnostics` | Detectar FFmpeg/FFprobe, capacidades, límites y métricas persistidas |
| GET, POST | `/api/v1/media/projects` | Listar proyectos o crearlos desde un borrador |
| GET, PATCH, DELETE | `/api/v1/media/projects/:id` | Consultar/configurar proyecto; borrar requiere confirmación y no elimina historial exportado |
| PATCH | `/api/v1/media/scenes/:id` | Editar texto, duración, transición y asignación de recurso |
| POST | `/api/v1/media/projects/:id/scenes/:sceneId/voice` | Encolar voz local para la narración guardada de una escena |
| GET | `/api/v1/media/voice-generations/:id` | Consultar estado y duración real de una generación |
| POST | `/api/v1/media/voice-generations/:id/cancel` | Cancelar síntesis local en curso |
| POST | `/api/v1/media/voice-generations/:id/unlink` | Desvincular una voz activa sin borrar su archivo |
| GET | `/api/v1/media/voice-generations/:id/file` | Reproducir un WAV validado |
| PUT, GET, DELETE | `/api/v1/media/assets` | Importar (cuerpo binario, nombre en `X-Media-Filename`), filtrar biblioteca |
| GET | `/api/v1/media/assets/:id/content` | Servir un archivo importado por identificador interno |
| POST | `/api/v1/media/projects/:id/render` | Encolar renderizado real con FFmpeg |
| POST | `/api/v1/media/projects/:id/plan` | Generar una propuesta audiovisual sin modificar el proyecto |
| POST | `/api/v1/media/projects/:id/plan/scenes/:sceneIndex/regenerate` | Regenerar una escena en la propuesta y conservar su duración |
| PUT | `/api/v1/media/projects/:id/plan` | Validar y aplicar una propuesta aprobada |
| GET | `/api/v1/media/jobs` y `/api/v1/media/jobs/:id` | Consultar trabajos y su estado |
| POST | `/api/v1/media/jobs/:id/cancel` y `/retry` | Cancelar o crear un nuevo intento manual |
| GET | `/api/v1/media/exports` | Listar solo exportaciones verificadas con FFprobe |
| GET | `/api/v1/media/exports/:id/file` y `/subtitles` | Descargar MP4 y SRT validados |

Las migraciones se aplican incrementalmente al abrir SQLite; Media Studio agrega `003_media_engine.sql`, la planificación IA `004_ai_scene_plans.sql` y la voz por escena `005_scene_voice.sql`, conservando los datos previos. Los archivos se guardan junto a la base de datos dentro de `media/`. El límite configurable es `MEDIA_MAX_UPLOAD_BYTES`; la concurrencia de render por defecto es 1 (máximo 2) mediante `MEDIA_MAX_CONCURRENT`, y el tiempo de render por defecto es 30 minutos (`MEDIA_RENDER_TIMEOUT_MS`). La síntesis local procesa un trabajo por vez y admite textos de hasta 3,000 caracteres.

## Alcance pendiente y seguridad

El dashboard, centro de contenido, calendario, cola local, respaldos, generador IA y Media Studio persisten en SQLite y se conectan a servicios reales. Permanecen pendientes tendencias, analítica externa, separación de diálogo por personaje, reordenamiento drag-and-drop de escenas y publicación/OAuth de redes. Windows SAPI usa las voces instaladas por el sistema; FFmpeg/FFprobe deben estar instalados y configurados para exportar MP4.

La API solo escucha en loopback. Los endpoints multimedia validan extensiones, firmas binarias básicas, tamaños, UUIDs y rutas internas administradas; no aceptan rutas locales del usuario como destino ni para servir archivos. No expongas el servicio fuera del equipo local sin autenticación/protecciones adicionales.

## Diagnóstico

- Si el frontend no conecta, comprueba que `npm.cmd run dev` mantenga activos ambos servicios y que los puertos 5173 y 3001 estén libres.
- Los datos y errores de API aparecen en la interfaz; los errores del backend se registran como JSON en la consola.
- Si `better-sqlite3` no tiene binario compatible con tu instalación de Node, prueba con una versión LTS soportada y vuelve a ejecutar `npm.cmd install`.
- Si FFmpeg aparece como no disponible, instala/configura ambos ejecutables y reinicia la API; `.env` se lee durante el inicio del backend.
- Si una escena no tiene recurso, el render puede usar su fondo de composición. Si la compilación de FFmpeg no trae el filtro de subtítulos/libass, desactiva su integración o instala una compilación con ese filtro.
- Si un recurso importado fue movido fuera de `data/media/assets`, vuelve a importarlo y reasigna la escena. VYRALIX no busca ni elimina archivos fuera de su carpeta administrada.
