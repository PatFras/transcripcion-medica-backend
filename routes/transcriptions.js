process.loadEnvFile();
const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const Transcription = require("../models/Transcription");
const router = express.Router();

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const transcribe = new AWS.TranscribeService();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, "..", "uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + "-" + file.originalname;
    console.log(`Guardando archivo como: ${uniqueName}`);
    cb(null, uniqueName);
  },
});

const upload = multer({ storage: storage });

router.post("/upload", upload.single("audio"), (req, res) => {
  const audioFilePath = path.resolve(
    __dirname,
    "..",
    "uploads",
    req.file.filename
  );
  const mp3FilePath = audioFilePath.replace(/\.[^/.]+$/, ".mp3");

  console.log("Ruta absoluta del archivo de audio:", audioFilePath);

  const fileExtension = path.extname(audioFilePath).toLowerCase();

  if (fileExtension === ".mp3") {
    subirAS3(audioFilePath, res);
  } else {
    console.log("Convertir archivo a .mp3:", mp3FilePath);

    execFile(
      "ffmpeg",
      ["-i", audioFilePath, mp3FilePath],
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Error de conversión: ${error}`);
          return res.status(500).json({ error: "Error converting audio" });
        }

        console.log("Conversión completada. Subiendo a S3.");
        subirAS3(mp3FilePath, res);
      }
    );
  }
});

function subirAS3(filePath, res) {
  const s3 = new AWS.S3();
  const params = {
    Bucket: "informe-med",
    Key: path.basename(filePath),
    Body: fs.createReadStream(filePath),
  };

  s3.upload(params, (err, data) => {
    if (err) {
      console.error(`Error al subir el archivo a S3: ${err}`);
      return res.status(500).json({ error: "Error uploading file to S3" });
    }

    console.log(`Archivo subido a S3: ${data.Location}`);

    const transcribeParams = {
      TranscriptionJobName: `Transcripcion_${Date.now()}`,
      LanguageCode: "es-ES",
      MediaFormat: "mp3",
      Media: {
        MediaFileUri: data.Location,
      },
      OutputBucketName: "informe-med",
    };

    transcribe.startTranscriptionJob(
      transcribeParams,
      (err, transcribeData) => {
        if (err) {
          console.error(`Error al iniciar la transcripción: ${err}`);
          return res
            .status(500)
            .json({ error: "Error starting transcription job" });
        }

        console.log(
          `Job de transcripción iniciado: ${transcribeData.TranscriptionJob.TranscriptionJobName}`
        );

        const checkTranscriptionJob = setInterval(() => {
          transcribe.getTranscriptionJob(
            {
              TranscriptionJobName:
                transcribeData.TranscriptionJob.TranscriptionJobName,
            },
            (err, jobData) => {
              if (err) {
                console.error(`Error al obtener el estado del job: ${err}`);
                clearInterval(checkTranscriptionJob);
                return res
                  .status(500)
                  .json({ error: "Error checking transcription job status" });
              }

              const jobStatus = jobData.TranscriptionJob.TranscriptionJobStatus;
              console.log(`Estado del job de transcripción: ${jobStatus}`);

              if (jobStatus === "COMPLETED") {
                clearInterval(checkTranscriptionJob);

                const transcriptUri =
                  jobData.TranscriptionJob.Transcript.TranscriptFileUri;
                console.log(`Transcripción completada: ${transcriptUri}`);

                // Nueva lógica para obtener el contenido del archivo JSON
                const transcriptFileName = path.basename(transcriptUri);
                const transcriptBucket = "informe-med";
                console.log(
                  `Verificando en el bucket ${transcriptBucket} con la clave ${transcriptFileName}`
                );

                s3.getObject(
                  { Bucket: transcriptBucket, Key: transcriptFileName },
                  (err, s3Data) => {
                    if (err) {
                      console.error(
                        `Error al obtener la transcripción de S3: ${err}`
                      );
                      return res
                        .status(500)
                        .json({ error: "Error getting transcription from S3" });
                    }

                    const transcriptionText = JSON.parse(
                      s3Data.Body.toString("utf-8")
                    ).results.transcripts[0].transcript;
                    console.log(`Texto transcripto: ${transcriptionText}`);

                    const newTranscription = new Transcription({
                      audioFile: path.basename(filePath),
                      transcriptionText,
                    });

                    newTranscription
                      .save()
                      .then(() => {
                        fs.unlink(filePath, (err) => {
                          if (err) console.error(`Error deleting file: ${err}`);
                        });
                        res.json(newTranscription);
                      })
                      .catch((err) => {
                        console.error(err);
                        res
                          .status(500)
                          .json({ error: "Error saving transcription" });
                      });
                  }
                );
              }
            }
          );
        }, 5000); // Revisar cada 5 segundos
      }
    );
  });
}

module.exports = router;
