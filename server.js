import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import pdfParse from "pdf-parse-fork";
import {RecursiveCharacterTextSplitter} from "@langchain/textsplitters"
import {GoogleGenAI} from "@google/genai";

dotenv.config()

const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static("public"))

const upload = multer({ dest: "uploads/" });
const splitter = new RecursiveCharacterTextSplitter({
    chunkSize:1000,
    chunkOverlap:200,
    separators:["\n\n","\n"," ",""]
});
const ai = new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})
let vectorDatabase = [];

async function embader(chunks){
    const embeddingPromise = chunks.map(
        chunk=>(
            ai.models.embedContent({
                model:"gemini-embedding-001",
                contents:chunk
            })
        )
    );

    const response = await Promise.all(embeddingPromise);
    const vectors = response.map(res => res.embedding?.values || res.embeddings?.[0]?.values);
    return vectors;

}

function cosineSiilarity(vecA,vecB){
    let dotProduct =0;
    let normA=0;
    let normB=0;

    for(let i=0;i<vecA.length;i++){
        dotProduct+=vecA[i]*vecB[i];
        normA+=vecA[i]*vecA[i];
        normB+=vecB[i]*vecB[i];
    }

    return dotProduct/(Math.sqrt(normA)*Math.sqrt(normB));
}

app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }

        const dataBuffer = fs.readFileSync(req.file.path);
        const data = await pdfParse(dataBuffer);
        const chunks = await splitter.splitText(data.text);
        const vectors = await embader(chunks);
        fs.unlinkSync(req.file.path);

        vectorDatabase = chunks.map((chunkText,index)=>(
            {   index,
                text:chunkText,
                vector:vectors[index]
            }
        ));
        

        res.json({
            message: "PDF Processed, embedded, and indexed succcesfully!",
            totalChunksStored:vectorDatabase.length
        });
    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        console.error("PDF Parsing Error:", error);
        res.status(500).json({ error: "Failed to parse PDF file." });
    }
});

app.post("/ask",async(req,res)=>{
    try {
        const {question} = req.body;
        if(!question) return res.status(400).json({
            error:"Question in Required"
        });

        if(vectorDatabase.length === 0) return res.status(400).json({
            error:"Please upload PDF First"
        });

        const [questionVector] = await embader([question]);
        const scoredChunks = vectorDatabase.map(item=>(
            {
                text:item.text,
                score:cosineSiilarity(questionVector,item.vector),
                index:item.index
            }
        ));

        scoredChunks.sort((a,b)=>b.score-a.score);
        const topChunks = scoredChunks.slice(0,3);
        const retrievedContext = topChunks.map(c=>c.text).join("\n\n---\n\n");

        const prompt = `You are a helpful assistant. Answer the user's question based strictly on the provided context below.
         If the context doesn't contain the answer, say "I couldn't find the answer in the provided document.
         CONTEXT FROM PDF:${retrievedContext}
         USER QUESTION:${question}`;

         const response = await ai.models.generateContent({
            model:"gemini-3.5-flash-lite",
            contents:prompt
         });

         res.json({
            question:question,
            answer:response.text,
            contextUsed:topChunks
         });

    } catch (error) {
        console.error("Query Error:", error);
        res.status(500).json({ error: "Failed to process question." });
    }
})

app.listen(5000, () => {
    console.log("Server running on port 5000...");
});