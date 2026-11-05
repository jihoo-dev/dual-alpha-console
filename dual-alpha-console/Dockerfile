FROM node:20-alpine

WORKDIR /app

# 캐시 효율을 위해 종속성 파일 먼저 복사
COPY package*.json ./
RUN npm install --omit=dev

# 소스 코드 복사
COPY . .

# Render 기본 포트 환경변수 바인딩
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]