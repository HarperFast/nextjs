export const metadata = {
	title: 'Harper - Next.js v16 Secrets App',
};

export default function RootLayout({ children }) {
	return (
		<html>
			<body>{children}</body>
		</html>
	);
}
