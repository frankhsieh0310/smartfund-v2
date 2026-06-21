"use client";

import { useState } from "react";

const questions = [
  "你的投資期間預計多久？",
  "遇到市場下跌20%，你會？",
  "你希望投資目標是？",
  "你過去有投資經驗嗎？",
  "你的年齡區間？",
];

const options = [
  { text: "保守", score: 1 },
  { text: "穩健", score: 2 },
  { text: "積極", score: 3 },
];

export default function QuizPage() {
  const [current, setCurrent] = useState(0);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);

  const handleAnswer = (value: number) => {
    const newScore = score + value;

    if (current + 1 < questions.length) {
      setScore(newScore);
      setCurrent(current + 1);
    } else {
      setScore(newScore);
      setFinished(true);
    }
  };

  const getResult = () => {
    if (score <= 7) {
      return {
        type: "保守型投資人",
        etf: "00937B、00751B",
        fund: "聯博美國收益基金",
      };
    }

    if (score <= 11) {
      return {
        type: "穩健型投資人",
        etf: "0050、006208",
        fund: "野村全球金融收益基金",
      };
    }

    return {
      type: "積極型投資人",
      etf: "QQQ、SOXX",
      fund: "貝萊德世界科技基金",
    };
  };

  if (finished) {
    const result = getResult();

    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="max-w-xl mx-auto p-10 text-center">

          <h1 className="text-5xl font-bold mb-8 text-yellow-400">
            測驗結果
          </h1>

          <h2 className="text-3xl font-bold mb-6">
            {result.type}
          </h2>

          <div className="bg-slate-900 rounded-2xl p-6 mb-6">
            <p>推薦 ETF</p>
            <p className="text-yellow-400 text-xl">
              {result.etf}
            </p>
          </div>

          <div className="bg-slate-900 rounded-2xl p-6">
            <p>推薦基金</p>
            <p className="text-yellow-400 text-xl">
              {result.fund}
            </p>
          </div>

        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center">

      <div className="max-w-2xl mx-auto p-10">

        <div className="mb-6 text-slate-400">
          第 {current + 1} / {questions.length} 題
        </div>

        <h1 className="text-4xl font-bold mb-10">
          {questions[current]}
        </h1>

        <div className="space-y-4">

          {options.map((option) => (
            <button
              key={option.text}
              onClick={() => handleAnswer(option.score)}
              className="w-full bg-slate-800 hover:bg-yellow-500 hover:text-black transition p-5 rounded-xl text-left"
            >
              {option.text}
            </button>
          ))}

        </div>

      </div>

    </main>
  );
}