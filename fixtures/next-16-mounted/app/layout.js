export const metadata = {
	title: 'Harper - Mounted Next.js App',
};

export default function RootLayout({ children }) {
	return (
		<html>
			<body>{children}</body>
		</html>
	);
}
